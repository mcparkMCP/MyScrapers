const mongoose = require('mongoose');
const axios = require('axios');
const cheerio = require('cheerio');
const { decode } = require('html-entities');
const { v4: uuidv4 } = require('uuid');
const { JobModel } = require('./Job');
const dbConnect = require('./dbConnect');
const { sendEmail, extractEmailsFromText, generateSalesEmailContent } = require('./helperFunctions/emailUtils');
require('dotenv').config();

// w4mpjobs.org - UK Parliamentary & Political Jobs
// Funded by House of Commons. Lists jobs for MPs, political orgs, think tanks, policy.
const BASE_URL = 'https://www.w4mpjobs.org';

function generateSlug(title, company, id) {
  const process = (str) =>
    (str || '')
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim();
  return `${process(title)}-at-${process(company)}-${id.slice(-6)}`;
}

function normalizeLink(link) {
  if (!link) return '';
  let url = link;
  if (url.startsWith(BASE_URL)) {
    url = url.substring(BASE_URL.length);
  }
  url = url.split('?')[0];
  if (!url.startsWith('/')) {
    url = '/' + url;
  }
  return url;
}

async function fetchJobDescription(jobId) {
  const fullUrl = `${BASE_URL}/JobDetails.aspx?jobid=${jobId}`;
  try {
    const res = await axios.get(fullUrl);
    const $ = cheerio.load(res.data);

    // Extract fields using itemprop microdata
    const title = decode($('p[itemprop="title"]').text().replace('Job Title:', '').trim());
    const company = decode($('p[itemprop="hiringOrganization"]').text().replace('Working For:', '').trim());
    const location = decode($('p[itemprop="jobLocation"]').text().replace('Location:', '').trim());
    const salaryText = decode($('p[itemprop="baseSalary"]').text().replace('Salary:', '').trim());
    const contractLength = decode($('p[itemprop="lengthofcontract"]').text().replace('Length of Contract:', '').trim());

    // Description from itemprop="description"
    let descriptionHtml = $('span[itemprop="description"]').html() || '';
    const $desc = cheerio.load(descriptionHtml || '');
    $desc('script, style, noscript').remove();
    const cleaned = decode($desc.text() || '').replace(/\s+/g, ' ').trim();

    // Application details from itemprop="experienceRequirements" (contains apply info)
    let applyHtml = $('p[itemprop="experienceRequirements"]').html() || '';
    let applyLink = fullUrl;
    // Try to find an apply link within the application details
    const $apply = cheerio.load(applyHtml || '');
    const applyAnchor = $apply('a').first();
    if (applyAnchor.length) {
      const href = applyAnchor.attr('href');
      if (href && href.startsWith('http')) {
        applyLink = href;
      }
    }

    // Closing date
    let closingDate = null;
    const closingText = $('strong:contains("Closing Date")').parent().text();
    const dateMatch = closingText.match(/Closing Date[:\s]*(\d{1,2}\s+\w+\s+\d{4})/i);
    if (dateMatch) {
      closingDate = new Date(dateMatch[1]);
      if (isNaN(closingDate.getTime())) closingDate = null;
    }

    // Website
    const websiteLink = $('a[itemprop="sameAs"]').first().attr('href') || '';

    // Extract emails
    let emails = extractEmailsFromText(cleaned);
    const applyText = decode($apply.text() || '');
    const applyEmails = extractEmailsFromText(applyText);
    emails.push(...applyEmails);
    $('a[href^="mailto:"]').each((_, el) => {
      const mailtoHref = $(el).attr('href');
      if (mailtoHref) {
        const email = mailtoHref.replace('mailto:', '').split('?')[0].trim();
        if (email && email.includes('@')) {
          emails.push(email);
        }
      }
    });
    emails = [...new Set(emails)];

    // Determine contract type
    let contractType = 'full-time';
    const contractLower = (contractLength || '').toLowerCase();
    if (contractLower.includes('permanent')) contractType = 'full-time';
    else if (contractLower.includes('fixed') || contractLower.includes('temporary')) contractType = 'fixed-term';
    else if (contractLower.includes('part')) contractType = 'part-time';
    else if (contractLower.includes('intern') || contractLower.includes('volunteer')) contractType = 'internship';

    return {
      title: title || 'Untitled',
      company: company || 'Unknown Company',
      location: location || 'London',
      salary: salaryText || '',
      description: cleaned || '(No description available)',
      applyLink,
      emails,
      closingDate,
      contractType,
    };
  } catch (err) {
    console.error(`Failed to fetch job detail: ${fullUrl}`, err.message);
    return {
      title: '',
      company: 'Unknown Company',
      location: 'London',
      salary: '',
      description: '',
      applyLink: fullUrl,
      emails: [],
      closingDate: null,
      contractType: 'full-time',
    };
  }
}

async function importJobsFromW4mp() {
  await dbConnect();

  let stats = {
    processed: 0,
    saved: 0,
    emailsFound: 0,
    emailsSent: 0,
  };

  console.log('\nStarting w4mpjobs scraper (UK Parliamentary & Political Jobs)...');
  console.log(`Email sending ${process.env.SENDGRID_API_KEY ? 'ENABLED' : 'DISABLED (SENDGRID_API_KEY not configured)'}`);

  await JobModel.syncIndexes();

  const existingLinks = new Set(
    (await JobModel.find({}, 'relativeLink')).map((d) => d.relativeLink)
  );

  const listUrl = `${BASE_URL}/SearchJobs.aspx?search=alljobs`;
  console.log(`\nFetching job list: ${listUrl}`);
  let res;
  try {
    res = await axios.get(listUrl);
  } catch (err) {
    console.error('Error fetching job list:', err.message);
    await mongoose.connection.close();
    return;
  }

  const $ = cheerio.load(res.data);

  // Extract job IDs from listing page
  // Structure: .jobadvertdetailbox#jobid contains <a href="JobDetails.aspx?jobid=XXXXX">
  const jobIds = [];
  $('div.jobadvertdetailbox').each((_, el) => {
    const id = $(el).attr('id');
    if (id === 'jobid') {
      const link = $(el).find('a[href*="jobid="]').first();
      if (link.length) {
        const href = link.attr('href') || '';
        const match = href.match(/jobid=(\d+)/);
        if (match) {
          jobIds.push(match[1]);
        }
      }
    }
  });

  // Deduplicate
  const uniqueJobIds = [...new Set(jobIds)];
  console.log(`Found ${uniqueJobIds.length} job listings`);

  for (const jobId of uniqueJobIds) {
    if (stats.processed >= 200) break;
    stats.processed++;

    const relativeLink = `/JobDetails.aspx?jobid=${jobId}`;

    if (existingLinks.has(relativeLink)) {
      console.log(`Skipping duplicate: ${relativeLink}`);
      continue;
    }

    const {
      title,
      company,
      location,
      salary,
      description,
      applyLink,
      emails,
      closingDate,
      contractType,
    } = await fetchJobDescription(jobId);

    if (!title || title === 'Untitled') {
      console.log(`Skipping job ${jobId} - no title found`);
      continue;
    }

    if (emails && emails.length) {
      stats.emailsFound += emails.length;
      console.log(`Found ${emails.length} email(s) in job: ${title}`);
    }

    const id = uuidv4();
    const slug = generateSlug(title, company, id);

    let seniority = 'mid-level';
    const lowered = title.toLowerCase();
    if (lowered.includes('intern') || lowered.includes('trainee')) seniority = 'intern';
    else if (lowered.includes('junior') || lowered.includes('assistant')) seniority = 'junior';
    else if (lowered.includes('senior') || lowered.includes('director') || lowered.includes('head of')) seniority = 'senior';

    const expiresOn = closingDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const newJob = new JobModel({
      _id: new mongoose.Types.ObjectId(),
      title,
      slug,
      description,
      companyName: company,
      sourceAgency: '',
      contractType,
      vacancyType: '',
      tags: ['Politics', 'Policy', 'Government'],
      remote: 'no',
      type: contractType === 'part-time' ? 'part-time' : 'full-time',
      salary: 0,
      city: location || 'London',
      country: 'United Kingdom',
      state: '',
      applyLink,
      relativeLink,
      contactEmail: emails && emails.length > 0 ? emails[0] : null,
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresOn,
      seniority,
      plan: 'basic',
      source: 'w4mp',
    });

    try {
      await newJob.save();
      stats.saved++;
      existingLinks.add(relativeLink);
      console.log(`Saved: ${title} at ${company}`);

      if (process.env.SENDGRID_API_KEY && emails && emails.length > 0) {
        try {
          const emailSubject = 'Post your policy job with us for just 100 GBP';
          const emailContent = generateSalesEmailContent();
          const sentEmails = new Set();
          for (const email of emails) {
            if (sentEmails.has(email)) continue;
            const result = await sendEmail(email, emailSubject, emailContent, {
              jobTitle: title,
              companyName: company,
              source: 'w4mp',
            });
            if (!result.error) {
              sentEmails.add(email);
              stats.emailsSent++;
              console.log(`Sales email sent to ${email} for ${title}`);
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
          }
        } catch (emailErr) {
          console.error(`Error sending sales emails for ${title}:`, emailErr.message);
        }
      } else if (emails && emails.length > 0 && !process.env.SENDGRID_API_KEY) {
        console.log('SENDGRID_API_KEY not configured. Skipping email sending.');
      }
    } catch (err) {
      if (err.code === 11000) {
        console.log(`Duplicate caught by DB index: ${relativeLink}`);
      } else {
        console.error(`Error saving ${title}:`, err.message);
      }
    }
  }

  console.log('\nFINAL STATISTICS:');
  console.log(`Jobs processed: ${stats.processed}`);
  console.log(`Jobs saved: ${stats.saved}`);
  console.log(`Emails found: ${stats.emailsFound}`);
  console.log(`Sales emails sent: ${stats.emailsSent}`);

  await mongoose.connection.close();
  console.log('Scraping completed');
}

importJobsFromW4mp().catch((err) => {
  console.error('Unhandled error in w4mp scraper:', err);
  mongoose.connection.close();
});
