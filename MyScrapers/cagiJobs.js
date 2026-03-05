const mongoose = require('mongoose');
const axios = require('axios');
const cheerio = require('cheerio');
const { decode } = require('html-entities');
const { v4: uuidv4 } = require('uuid');
const { JobModel } = require('./Job');
const dbConnect = require('./dbConnect');
const { sendEmail, extractEmailsFromText, generateSalesEmailContent } = require('./helperFunctions/emailUtils');
require('dotenv').config();

const BASE_URL = 'https://jobs.cagi.ch';

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

    // Extract company name from employer sidebar
    let companyName = 'Unknown Company';
    const employerLink = $('.job-employer-header .employer-links a.more-link').first();
    if (employerLink.length) {
      companyName = decode(employerLink.text().trim());
    }

    // Extract description from the custom field content
    let descriptionHtml =
      $('.custom-field-data.job-description .content').html() ||
      $('.job-detail-description .content').html() ||
      $('.job-detail-description').html() ||
      '';

    const $desc = cheerio.load(descriptionHtml || '');
    $desc('script, style, noscript').remove();
    const cleaned = decode($desc.text() || '').replace(/\s+/g, ' ').trim();

    // Extract apply link
    let applyLink = '';
    const applyBtn = $('a.btn-apply-job-external').first();
    if (applyBtn.length) {
      applyLink = applyBtn.attr('href') || '';
    }

    // Extract emails
    let emails = extractEmailsFromText(cleaned);
    // Check mailto links
    $('a[href^="mailto:"]').each((_, el) => {
      const mailtoHref = $(el).attr('href');
      if (mailtoHref) {
        const email = mailtoHref.replace('mailto:', '').split('?')[0].trim();
        if (email && email.includes('@')) {
          emails.push(email);
        }
      }
    });
    // Check apply button for mailto
    if (applyLink && applyLink.startsWith('mailto:')) {
      const email = applyLink.replace('mailto:', '').split('?')[0].trim();
      if (email && email.includes('@')) {
        emails.push(email);
      }
    }
    emails = [...new Set(emails)];

    // Extract job type
    let contractType = '';
    const typeEl = $('a.type-job').first();
    if (typeEl.length) {
      const typeText = typeEl.text().toLowerCase();
      if (typeText.includes('permanent') || typeText.includes('cdi')) contractType = 'full-time';
      else if (typeText.includes('fixed') || typeText.includes('cdd')) contractType = 'fixed-term';
      else if (typeText.includes('intern')) contractType = 'internship';
      else if (typeText.includes('consultant')) contractType = 'consultant';
      else if (typeText.includes('part')) contractType = 'part-time';
      else contractType = 'full-time';
    }

    // Extract location
    let location = '';
    const locationEl = $('.job-metas-detail .job-location a').first();
    if (locationEl.length) {
      location = decode(locationEl.text().trim());
    }

    // Extract category
    let category = '';
    const categoryEl = $('.job-metas-detail .category-job a').first();
    if (categoryEl.length) {
      category = decode(categoryEl.text().trim());
    }

    return {
      description: cleaned || '(No description available)',
      companyName,
      applyLink: applyLink && !applyLink.startsWith('mailto:') ? applyLink : fullUrl,
      emails,
      contractType: contractType || 'full-time',
      location,
      category,
    };
  } catch (err) {
    console.error(`Failed to fetch job detail: ${fullUrl}`, err.message);
    return {
      description: '',
      companyName: 'Unknown Company',
      applyLink: fullUrl,
      emails: [],
      contractType: 'full-time',
      location: '',
      category: '',
    };
  }
}

async function importJobsFromCagi() {
  await dbConnect();

  let stats = {
    processed: 0,
    saved: 0,
    emailsFound: 0,
    emailsSent: 0,
  };

  console.log('\nStarting CAGI Jobs scraper...');
  console.log(`Email sending ${process.env.SENDGRID_API_KEY ? 'ENABLED' : 'DISABLED (SENDGRID_API_KEY not configured)'}`);

  await JobModel.syncIndexes();

  const existingLinks = new Set(
    (await JobModel.find({}, 'relativeLink')).map((d) => d.relativeLink)
  );

  let page = 1;
  let continuePaging = true;

  while (continuePaging && stats.processed < 200) {
    const pageUrl = page === 1
      ? `${BASE_URL}/jobs/`
      : `${BASE_URL}/jobs/page/${page}/`;
    console.log(`\nFetching job list page ${page}: ${pageUrl}`);
    let res;
    try {
      res = await axios.get(pageUrl);
    } catch (err) {
      console.error(`Error fetching page ${page}:`, err.message);
      break;
    }
    const $ = cheerio.load(res.data);
    const cards = $('article.job_listing');

    if (!cards || cards.length === 0) {
      console.log(`No job cards found on page ${page}. Stopping.`);
      break;
    }

    for (let i = 0; i < cards.length && stats.processed < 200; i++) {
      stats.processed++;
      const card = cards[i];
      const titleEl = $(card).find('h2.job-title a').first();
      const rawLink = titleEl.attr('href');
      if (!rawLink) continue;
      const relativeLink = normalizeLink(rawLink);

      if (existingLinks.has(relativeLink)) {
        console.log(`Skipping duplicate: ${relativeLink}`);
        continue;
      }

      const title = decode(titleEl.text().trim());

      // Fetch detail page
      const {
        description,
        companyName,
        applyLink,
        emails,
        contractType,
        location,
        category,
      } = await fetchJobDescription(relativeLink);

      if (emails && emails.length) {
        stats.emailsFound += emails.length;
        console.log(`Found ${emails.length} email(s) in job: ${title}`);
      }

      const id = uuidv4();
      const company = companyName || 'Unknown Company';
      const slug = generateSlug(title, company, id);

      let seniority = 'mid-level';
      const lowered = title.toLowerCase();
      if (lowered.includes('intern') || lowered.includes('stage')) seniority = 'intern';
      else if (lowered.includes('junior')) seniority = 'junior';
      else if (lowered.includes('senior')) seniority = 'senior';

      const newJob = new JobModel({
        _id: new mongoose.Types.ObjectId(),
        title,
        slug,
        description,
        companyName: company,
        sourceAgency: '',
        contractType,
        vacancyType: '',
        tags: category ? [category] : [],
        remote: 'no',
        type: contractType,
        salary: 0,
        city: location || 'Geneva',
        country: 'Switzerland',
        state: '',
        applyLink,
        relativeLink,
        contactEmail: emails && emails.length > 0 ? emails[0] : null,
        createdAt: new Date(),
        updatedAt: new Date(),
        expiresOn: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        seniority,
        plan: 'basic',
        source: 'cagi',
      });

      try {
        await newJob.save();
        stats.saved++;
        existingLinks.add(relativeLink);
        console.log(`Saved: ${title}`);

        if (process.env.SENDGRID_API_KEY && emails && emails.length > 0) {
          try {
            const emailSubject = 'CAGI charges CHF 450 we charge CHF 50';
            const emailContent = generateSalesEmailContent();
            const sentEmails = new Set();
            for (const email of emails) {
              if (sentEmails.has(email)) continue;
              const result = await sendEmail(email, emailSubject, emailContent, {
                jobTitle: title,
                companyName: company,
                source: 'cagi',
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

    // Check for next page
    const nextPageLink = $('a.page-numbers').filter((_, el) => {
      const href = $(el).attr('href') || '';
      return href.includes(`/page/${page + 1}/`);
    });
    if (nextPageLink.length > 0) {
      page++;
    } else {
      continuePaging = false;
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

importJobsFromCagi().catch((err) => {
  console.error('Unhandled error in CAGI scraper:', err);
  mongoose.connection.close();
});
