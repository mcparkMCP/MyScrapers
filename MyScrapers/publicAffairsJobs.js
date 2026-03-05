const mongoose = require('mongoose');
const axios = require('axios');
const cheerio = require('cheerio');
const { decode } = require('html-entities');
const { v4: uuidv4 } = require('uuid');
const { JobModel } = require('./Job');
const dbConnect = require('./dbConnect');
const { sendEmail, extractEmailsFromText, generateSalesEmailContent } = require('./helperFunctions/emailUtils');
require('dotenv').config();

const BASE_URL = 'https://www.publicaffairsnetworking.com';

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

    // Title from h1
    const title = decode($('h1').first().text().trim());

    // Company from .job-logo img alt
    let companyName = '';
    const logoImg = $('.job-logo img').first();
    if (logoImg.length) {
      companyName = decode(logoImg.attr('alt') || '').trim();
    }

    // Salary and location from .job-detail-snippet li
    let salary = '';
    let location = '';
    let specialism = '';
    $('.job-detail-snippet li').each((_, el) => {
      const text = $(el).text().trim();
      if (text.startsWith('Salary:')) salary = text.replace('Salary:', '').trim();
      else if (text.startsWith('Location:')) location = text.replace('Location:', '').trim();
      else if (text.startsWith('Specialism:')) specialism = text.replace('Specialism:', '').trim();
    });

    // Description from .page-content sections (skip "To Apply", "Closing date", "Apply online")
    let descriptionParts = [];
    $('section.page-content').each((_, el) => {
      const heading = $(el).find('h2').first().text().trim().toLowerCase();
      if (heading === 'to apply' || heading === 'closing date' || heading === 'apply online') return;
      const html = $(el).html() || '';
      if (html.trim()) descriptionParts.push(html);
    });
    const descriptionHtml = descriptionParts.join('<br>');
    const $desc = cheerio.load(descriptionHtml || '');
    $desc('script, style, noscript, form, input, label, h2').remove();
    const cleaned = decode($desc.text() || '').replace(/\s+/g, ' ').trim();

    // Apply link from .button a.tracking or .button a
    let applyLink = fullUrl;
    const applyBtn = $('a.tracking').first();
    if (applyBtn.length) {
      const href = applyBtn.attr('href');
      if (href && href.startsWith('http')) {
        applyLink = href;
      }
    }

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

    // Closing date
    let closingDate = null;
    $('section.page-content').each((_, el) => {
      const heading = $(el).find('h2').first().text().trim().toLowerCase();
      if (heading === 'closing date') {
        const dateText = $(el).text();
        const dateMatch = dateText.match(/(\d{1,2})\w*\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i);
        if (dateMatch) {
          closingDate = new Date(`${dateMatch[1]} ${dateMatch[2]} ${dateMatch[3]}`);
        }
      }
    });

    return {
      description: cleaned || '(No description available)',
      companyName: companyName || 'Unknown Company',
      applyLink,
      emails,
      salary,
      location,
      specialism,
      closingDate,
    };
  } catch (err) {
    console.error(`Failed to fetch job detail: ${fullUrl}`, err.message);
    return {
      description: '',
      companyName: 'Unknown Company',
      applyLink: fullUrl,
      emails: [],
      salary: '',
      location: '',
      specialism: '',
      closingDate: null,
    };
  }
}

async function importJobsFromPublicAffairs() {
  await dbConnect();

  let stats = {
    processed: 0,
    saved: 0,
    emailsFound: 0,
    emailsSent: 0,
  };

  console.log('\nStarting Public Affairs Networking Jobs scraper...');
  console.log(`Email sending ${process.env.SENDGRID_API_KEY ? 'ENABLED' : 'DISABLED (SENDGRID_API_KEY not configured)'}`);

  await JobModel.syncIndexes();

  const existingLinks = new Set(
    (await JobModel.find({}, 'relativeLink')).map((d) => d.relativeLink)
  );

  const pageUrl = `${BASE_URL}/public-affairs-jobs.php`;
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

  // Job cards are <li> elements inside #left-column that have vacancy links
  // The main listing area contains <li> with .job-titles h2 and a[href*="/vacancy/"]
  const vacancyLinks = [];
  $('a[href*="/vacancy/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href && !vacancyLinks.includes(href)) {
      // Only grab links from the main listing, not nav dropdowns
      const h2 = $(el).find('.job-titles h2').first();
      if (h2.length) {
        vacancyLinks.push(href);
      }
    }
  });

  // Deduplicate - each vacancy appears multiple times in nav
  const uniqueLinks = [...new Set(vacancyLinks)];

  if (uniqueLinks.length === 0) {
    // Fallback: grab all vacancy links that have h2 nearby
    $('li').each((_, li) => {
      const link = $(li).find('a[href*="/vacancy/"]').first();
      const h2 = $(li).find('h2').first();
      if (link.length && h2.length) {
        const href = link.attr('href');
        if (href && !uniqueLinks.includes(href)) {
          uniqueLinks.push(href);
        }
      }
    });
  }

  console.log(`Found ${uniqueLinks.length} vacancy links`);

  for (const href of uniqueLinks) {
    if (stats.processed >= 200) break;
    stats.processed++;

    const relativeLink = normalizeLink(href);

    if (existingLinks.has(relativeLink)) {
      console.log(`Skipping duplicate: ${relativeLink}`);
      continue;
    }

    // Fetch detail page for full data
    const {
      description,
      companyName,
      applyLink,
      emails,
      salary,
      location,
      specialism,
      closingDate,
    } = await fetchJobDescription(relativeLink);

    // Extract title from the relativeLink slug as fallback
    const title = description
      ? decode($(`a[href*="${href}"] .job-titles h2`).first().text().trim()) || relativeLink.split('/').pop().replace(/-/g, ' ').replace(/\d+-\d+-pubaffairs$/, '').trim()
      : 'Untitled';

    if (emails && emails.length) {
      stats.emailsFound += emails.length;
      console.log(`Found ${emails.length} email(s) in job: ${title}`);
    }

    const id = uuidv4();
    const company = companyName || 'Unknown Company';
    const slug = generateSlug(title, company, id);

    let seniority = 'mid-level';
    const lowered = title.toLowerCase();
    if (lowered.includes('intern')) seniority = 'intern';
    else if (lowered.includes('junior') || lowered.includes('assistant')) seniority = 'junior';
    else if (lowered.includes('senior') || lowered.includes('director') || lowered.includes('head of')) seniority = 'senior';

    // Parse location into city
    let city = location || 'London';
    let remote = 'no';
    if (location && location.toLowerCase().includes('hybrid')) remote = 'partial';
    if (location && location.toLowerCase().includes('remote')) remote = 'yes';

    const tags = ['Public Affairs', 'Policy'];
    if (specialism) {
      specialism.split(',').forEach((s) => {
        const trimmed = s.trim();
        if (trimmed) tags.push(trimmed);
      });
    }

    const expiresOn = closingDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const newJob = new JobModel({
      _id: new mongoose.Types.ObjectId(),
      title,
      slug,
      description,
      companyName: company,
      sourceAgency: '',
      contractType: 'full-time',
      vacancyType: '',
      tags,
      remote,
      type: 'full-time',
      salary: 0,
      city,
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
      source: 'publicaffairs',
    });

    try {
      await newJob.save();
      stats.saved++;
      existingLinks.add(relativeLink);
      console.log(`Saved: ${title} at ${company}`);

      if (process.env.SENDGRID_API_KEY && emails && emails.length > 0) {
        try {
          const emailSubject = 'Post your public affairs job with us for just 100 GBP';
          const emailContent = generateSalesEmailContent();
          const sentEmails = new Set();
          for (const email of emails) {
            if (sentEmails.has(email)) continue;
            const result = await sendEmail(email, emailSubject, emailContent, {
              jobTitle: title,
              companyName: company,
              source: 'publicaffairs',
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

importJobsFromPublicAffairs().catch((err) => {
  console.error('Unhandled error in Public Affairs scraper:', err);
  mongoose.connection.close();
});
