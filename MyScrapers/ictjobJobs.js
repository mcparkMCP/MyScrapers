const mongoose = require('mongoose');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cheerio = require('cheerio');
const { decode } = require('html-entities');
const { v4: uuidv4 } = require('uuid');
const { JobModel } = require('./Job');
const dbConnect = require('./dbConnect');
const { sendEmail, extractEmailsFromText, generateSalesEmailContent } = require('./helperFunctions/emailUtils');
require('dotenv').config();

puppeteer.use(StealthPlugin());

const BASE_URL = 'https://www.ictjob.lu';
const LIST_URL = `${BASE_URL}/en/search-it-jobs`;

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

async function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1920,1080',
    ],
  });
}

async function getJobLinks(browser) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1920, height: 1080 });
    await page.goto(LIST_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    // Wait for JS to render job list
    await new Promise((r) => setTimeout(r, 5000));

    const jobs = await page.evaluate(() => {
      return [...document.querySelectorAll('a[href]')]
        .filter((a) => a.href.match(/\/en\/job\//))
        .map((a) => ({
          href: a.href,
          title: a.textContent.trim(),
        }));
    });
    return jobs;
  } finally {
    await page.close();
  }
}

async function getDetailPage(browser, url) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1920, height: 1080 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 3000));

    const data = await page.evaluate(() => {
      // Title
      const h1 = document.querySelector('h1');
      const title = h1 ? h1.textContent.trim() : '';

      // Company from .apply-job-company or company image alt
      let company = '';
      const companyEl = document.querySelector('.apply-job-company');
      if (companyEl) company = companyEl.textContent.trim();
      if (!company) {
        const logoImg = document.querySelector('.job-offer-logo-image');
        if (logoImg) company = (logoImg.alt || '').replace(/\s*logo$/i, '').trim();
      }

      // Description from .job-offer-edited-content or .post-item.job-offer-content
      let description = '';
      const descEl = document.querySelector('.job-offer-edited-content');
      if (descEl) {
        description = descEl.textContent.trim();
      }
      if (!description) {
        const contentEl = document.querySelector('.post-item.job-offer-content');
        if (contentEl) description = contentEl.textContent.trim();
      }
      // Company description as fallback/supplement
      const compDescEl = document.querySelector('.job-company-description');
      const compDesc = compDescEl ? compDescEl.textContent.trim() : '';
      if (compDesc && description) {
        description = description + ' ' + compDesc;
      } else if (compDesc && !description) {
        description = compDesc;
      }

      // Metadata from criteria summary
      const criteria = {};
      document.querySelectorAll('.job-offer-criteria-summary-container dt, .job-offer-criteria-summary-container dd').forEach((el) => {
        if (el.tagName === 'DT') criteria._lastKey = el.textContent.trim();
        if (el.tagName === 'DD' && criteria._lastKey) {
          criteria[criteria._lastKey] = el.textContent.trim();
          delete criteria._lastKey;
        }
      });

      // Languages from language section
      const languages = [];
      document.querySelectorAll('.job-language-name').forEach((el) => {
        languages.push(el.textContent.trim());
      });

      // Apply link
      let applyLink = '';
      const applyBtn = document.querySelector('a.apply-button');
      if (applyBtn) applyLink = applyBtn.href || '';

      return { title, company, description, criteria, languages, applyLink };
    });

    return data;
  } finally {
    await page.close();
  }
}

async function importJobsFromIctjob() {
  await dbConnect();

  let stats = { processed: 0, saved: 0, emailsFound: 0, emailsSent: 0 };

  console.log('\nStarting ICTjob.lu Luxembourg IT Jobs scraper (Puppeteer + Stealth)...');
  console.log(`Email sending ${process.env.SENDGRID_API_KEY ? 'ENABLED' : 'DISABLED (SENDGRID_API_KEY not configured)'}`);

  await JobModel.syncIndexes();

  const existingLinks = new Set(
    (await JobModel.find({}, 'relativeLink')).map((d) => d.relativeLink)
  );

  console.log('Launching headless browser...');
  const browser = await launchBrowser();

  try {
    console.log(`\nFetching job list: ${LIST_URL}`);
    const rawLinks = await getJobLinks(browser);
    console.log(`Found ${rawLinks.length} job links on listing page`);

    // Deduplicate
    const seen = new Set();
    const uniqueJobs = [];
    for (const j of rawLinks) {
      const rel = normalizeLink(j.href);
      if (!seen.has(rel) && rel.length > 10) {
        seen.add(rel);
        uniqueJobs.push({ relativeLink: rel, listTitle: j.title });
      }
    }
    console.log(`Unique jobs to process: ${uniqueJobs.length}`);

    for (const job of uniqueJobs) {
      if (stats.processed >= 100) break;
      stats.processed++;

      if (existingLinks.has(job.relativeLink)) {
        console.log(`Skipping duplicate: ${job.relativeLink}`);
        continue;
      }

      let detail;
      try {
        detail = await getDetailPage(browser, `${BASE_URL}${job.relativeLink}`);
      } catch (err) {
        console.error(`Failed to fetch ${job.relativeLink}:`, err.message);
        continue;
      }

      const title = detail.title || job.listTitle || 'Untitled';
      // Clean company - remove company prefix from title format "Company - Title"
      let company = detail.company || 'Unknown Company';
      const description = (detail.description || '').replace(/\s+/g, ' ').trim() || '(No description available)';

      // Extract emails
      let emails = extractEmailsFromText(description);
      emails = [...new Set(emails)];

      if (emails.length) {
        stats.emailsFound += emails.length;
        console.log(`Found ${emails.length} email(s) in job: ${title}`);
      }

      // Contract type
      let contractType = 'full-time';
      const critContract = (detail.criteria['Contract'] || detail.criteria['Contrat'] || '').toLowerCase();
      if (critContract.includes('freelance')) contractType = 'freelance';
      else if (critContract.includes('interim') || critContract.includes('temporary')) contractType = 'temporary';
      else if (critContract.includes('stage') || critContract.includes('intern')) contractType = 'internship';

      // Location
      let location = detail.criteria['Location'] || detail.criteria['Localisation'] || 'Luxembourg';

      const id = uuidv4();
      const slug = generateSlug(title, company, id);

      let seniority = 'mid-level';
      const lowered = title.toLowerCase();
      if (lowered.includes('intern') || lowered.includes('stage') || lowered.includes('junior')) seniority = 'junior';
      else if (lowered.includes('senior') || lowered.includes('lead') || lowered.includes('head') || lowered.includes('director')) seniority = 'senior';

      let remote = 'no';
      const locLower = location.toLowerCase();
      if (locLower.includes('remote')) remote = 'yes';
      else if (locLower.includes('hybrid')) remote = 'partial';

      const tags = ['Luxembourg', 'IT', 'Technology'];
      if (detail.languages && detail.languages.length) {
        detail.languages.forEach((l) => { if (l) tags.push(l); });
      }

      const applyLink = detail.applyLink || `${BASE_URL}${job.relativeLink}`;
      const expiresOn = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      const newJob = new JobModel({
        _id: new mongoose.Types.ObjectId(),
        title,
        slug,
        description,
        companyName: company,
        sourceAgency: '',
        contractType,
        vacancyType: '',
        tags,
        remote,
        type: contractType === 'part-time' ? 'part-time' : 'full-time',
        salary: 0,
        city: location || 'Luxembourg',
        country: 'Luxembourg',
        state: '',
        applyLink,
        relativeLink: job.relativeLink,
        contactEmail: emails.length > 0 ? emails[0] : null,
        createdAt: new Date(),
        updatedAt: new Date(),
        expiresOn,
        seniority,
        plan: 'basic',
        source: 'ictjob',
      });

      try {
        await newJob.save();
        stats.saved++;
        existingLinks.add(job.relativeLink);
        console.log(`Saved: ${title} at ${company}`);

        if (process.env.SENDGRID_API_KEY && emails.length > 0) {
          try {
            const emailSubject = 'Post your Luxembourg IT job with us for just 100 EUR';
            const emailContent = generateSalesEmailContent();
            const sentEmails = new Set();
            for (const email of emails) {
              if (sentEmails.has(email)) continue;
              const result = await sendEmail(email, emailSubject, emailContent, {
                jobTitle: title,
                companyName: company,
                source: 'ictjob',
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
        } else if (emails.length > 0 && !process.env.SENDGRID_API_KEY) {
          console.log('SENDGRID_API_KEY not configured. Skipping email sending.');
        }
      } catch (err) {
        if (err.code === 11000) {
          console.log(`Duplicate caught by DB index: ${job.relativeLink}`);
        } else {
          console.error(`Error saving ${title}:`, err.message);
        }
      }
    }
  } finally {
    await browser.close();
    console.log('Browser closed.');
  }

  console.log('\nFINAL STATISTICS:');
  console.log(`Jobs processed: ${stats.processed}`);
  console.log(`Jobs saved: ${stats.saved}`);
  console.log(`Emails found: ${stats.emailsFound}`);
  console.log(`Sales emails sent: ${stats.emailsSent}`);

  await mongoose.connection.close();
  console.log('Scraping completed');
}

importJobsFromIctjob().catch((err) => {
  console.error('Unhandled error in ICTjob scraper:', err);
  mongoose.connection.close();
});
