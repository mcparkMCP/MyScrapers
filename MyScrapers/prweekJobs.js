const mongoose = require('mongoose');
const axios = require('axios');
const cheerio = require('cheerio');
const { decode } = require('html-entities');
const { v4: uuidv4 } = require('uuid');
const { JobModel } = require('./Job');
const dbConnect = require('./dbConnect');
const { sendEmail, extractEmailsFromText, generateSalesEmailContent } = require('./helperFunctions/emailUtils');
require('dotenv').config();

const BASE_URL = 'https://jp.prweekjobs.co.uk';

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
  if (url.length > 1 && url.endsWith('/')) {
    url = url.slice(0, -1);
  }
  if (!url.startsWith('/')) {
    url = '/' + url;
  }
  return url;
}

async function fetchJobDescription(relativeLink) {
  const fullUrl = `${BASE_URL}${relativeLink}`;
  try {
    const res = await axios.get(fullUrl);
    const $ = cheerio.load(res.data);

    // Description is in #job.full-description
    let descriptionHtml = $('#job.full-description').html() || '';
    if (!descriptionHtml) {
      descriptionHtml = $('.full-description').html() || '';
    }
    const $desc = cheerio.load(descriptionHtml || '');
    $desc('script, style, noscript').remove();
    const cleaned = decode($desc.text() || '').replace(/\s+/g, ' ').trim();

    // Extract emails
    let emails = extractEmailsFromText(cleaned);
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

    // Company name from picture alt on detail page
    let companyName = '';
    const picAlt = $('.picture img').first().attr('alt') || '';
    if (picAlt) {
      companyName = picAlt.replace(/^Picture of\s*/i, '').trim();
    }

    return {
      description: cleaned || '(No description available)',
      emails,
      companyName: companyName || 'Unknown Company',
    };
  } catch (err) {
    console.error(`Failed to fetch job detail: ${fullUrl}`, err.message);
    return { description: '', emails: [], companyName: 'Unknown Company' };
  }
}

async function importJobsFromPRWeek() {
  await dbConnect();

  let stats = {
    processed: 0,
    saved: 0,
    emailsFound: 0,
    emailsSent: 0,
  };

  console.log('\nStarting PRWeek Jobs scraper...');
  console.log(`Email sending ${process.env.SENDGRID_API_KEY ? 'ENABLED' : 'DISABLED (SENDGRID_API_KEY not configured)'}`);

  await JobModel.syncIndexes();

  const existingLinks = new Set(
    (await JobModel.find({}, 'relativeLink')).map((d) => d.relativeLink)
  );

  const pageUrl = `${BASE_URL}/jobs`;
  console.log(`\nFetching job list: ${pageUrl}`);
  let res;
  try {
    res = await axios.get(pageUrl);
  } catch (err) {
    console.error('Error fetching job list:', err.message);
    await mongoose.connection.close();
    return;
  }

  const $ = cheerio.load(res.data);
  const cards = $('.product-item.job-box');

  if (!cards || cards.length === 0) {
    console.log('No job cards found. Stopping.');
    await mongoose.connection.close();
    return;
  }

  console.log(`Found ${cards.length} job cards`);

  for (let i = 0; i < cards.length && stats.processed < 200; i++) {
    stats.processed++;
    const card = cards[i];
    const titleEl = $(card).find('h2.product-title a').first();
    const rawLink = titleEl.attr('href');
    if (!rawLink) continue;
    const relativeLink = normalizeLink(rawLink);

    if (existingLinks.has(relativeLink)) {
      console.log(`Skipping duplicate: ${relativeLink}`);
      continue;
    }

    const title = decode(titleEl.text().trim());

    // Extract metadata from .job-info-list li p (location, salary, type)
    const infoItems = $(card).find('.job-info-list li p');
    let location = '';
    let salaryText = '';
    let jobType = 'full-time';
    infoItems.each((idx, el) => {
      const text = decode($(el).text().trim());
      if (idx === 0) location = text;
      if (idx === 1) salaryText = text;
      if (idx === 2) {
        const lower = text.toLowerCase();
        if (lower.includes('part')) jobType = 'part-time';
        else if (lower.includes('contract')) jobType = 'contract';
        else if (lower.includes('freelance')) jobType = 'freelance';
      }
    });

    // Company from listing picture alt
    let listingCompany = '';
    const picAlt = $(card).find('.picture img').first().attr('alt') || '';
    if (picAlt) {
      listingCompany = picAlt.replace(/^Picture of\s*/i, '').trim();
    }

    // Fetch detail page
    const { description, emails, companyName: detailCompany } = await fetchJobDescription(relativeLink);
    const company = (detailCompany && detailCompany !== 'Unknown Company') ? detailCompany : (listingCompany || 'Unknown Company');

    if (emails && emails.length) {
      stats.emailsFound += emails.length;
      console.log(`Found ${emails.length} email(s) in job: ${title}`);
    }

    const id = uuidv4();
    const slug = generateSlug(title, company, id);

    let seniority = 'mid-level';
    const lowered = title.toLowerCase();
    if (lowered.includes('intern')) seniority = 'intern';
    else if (lowered.includes('junior') || lowered.includes('assistant')) seniority = 'junior';
    else if (lowered.includes('senior') || lowered.includes('director') || lowered.includes('head of')) seniority = 'senior';

    const newJob = new JobModel({
      _id: new mongoose.Types.ObjectId(),
      title,
      slug,
      description,
      companyName: company,
      sourceAgency: '',
      contractType: jobType,
      vacancyType: '',
      tags: ['PR', 'Communications'],
      remote: 'no',
      type: jobType,
      salary: 0,
      city: location || 'London',
      country: 'United Kingdom',
      state: '',
      applyLink: `${BASE_URL}${relativeLink}`,
      relativeLink,
      contactEmail: emails && emails.length > 0 ? emails[0] : null,
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresOn: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      seniority,
      plan: 'basic',
      source: 'prweek',
    });

    try {
      await newJob.save();
      stats.saved++;
      existingLinks.add(relativeLink);
      console.log(`Saved: ${title}`);

      if (process.env.SENDGRID_API_KEY && emails && emails.length > 0) {
        try {
          const emailSubject = 'PRWeek charges thousands - we charge just 100 GBP';
          const emailContent = generateSalesEmailContent();
          const sentEmails = new Set();
          for (const email of emails) {
            if (sentEmails.has(email)) continue;
            const result = await sendEmail(email, emailSubject, emailContent, {
              jobTitle: title,
              companyName: company,
              source: 'prweek',
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

importJobsFromPRWeek().catch((err) => {
  console.error('Unhandled error in PRWeek scraper:', err);
  mongoose.connection.close();
});
