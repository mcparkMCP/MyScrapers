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

const BASE_URL = 'https://www.moovijob.com';
const LIST_URL = `${BASE_URL}/offres-emploi/jobs-luxembourg`;

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

async function getPageHtml(browser, url, waitSelector, timeout = 30000) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1920, height: 1080 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout });
    if (waitSelector) {
      await page.waitForSelector(waitSelector, { timeout: 15000 }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 2000));
    return await page.content();
  } finally {
    await page.close();
  }
}

function parseListingCard($, el) {
  const href = $(el).attr('href') || '';
  const title = decode($(el).find('.card-job-offer-new-title').text().trim());
  const company = decode($(el).find('.company-name').text().trim());
  const companyLogo = $(el).find('.company-picture img').attr('alt') || '';

  // Location and contract type from badge elements
  const badges = [];
  $(el).find('.badge').each((_, b) => {
    badges.push(decode($(b).text().trim()));
  });
  // First badge is usually location, second is contract type
  const location = badges[0] || '';
  const contractBadge = badges[1] || '';

  return { href, title, company: company || companyLogo.replace(/\s*logo$/i, ''), location, contractBadge };
}

function parseDetailPage(html) {
  const $ = cheerio.load(html);

  // Try JSON-LD first (most reliable)
  let title = '';
  let company = '';
  let description = '';
  let closingDate = null;
  let postedDate = null;

  const jsonLdScript = $('script[type="application/ld+json"]').first().html();
  if (jsonLdScript) {
    try {
      const ld = JSON.parse(jsonLdScript);
      if (ld['@type'] === 'JobPosting') {
        title = ld.title || '';
        if (ld.hiringOrganization) {
          company = ld.hiringOrganization.name || '';
        }
        if (ld.description) {
          const $d = cheerio.load(ld.description);
          $d('script, style').remove();
          description = decode($d.text()).replace(/\s+/g, ' ').trim();
        }
        if (ld.validThrough) {
          closingDate = new Date(ld.validThrough);
          if (isNaN(closingDate.getTime())) closingDate = null;
        }
        if (ld.datePosted) {
          postedDate = new Date(ld.datePosted);
        }
      }
    } catch (e) {
      // JSON-LD parse failed
    }
  }

  // Also try text in the JSON-LD that might be embedded in page text
  if (!description) {
    const bodyText = $('.job-offer-main-content').text() || '';
    const ldMatch = bodyText.match(/\{"@context".*?"@type"\s*:\s*"JobPosting".*?\}/s);
    if (ldMatch) {
      try {
        const ld = JSON.parse(ldMatch[0]);
        if (ld.description) {
          const $d = cheerio.load(ld.description);
          $d('script, style').remove();
          description = decode($d.text()).replace(/\s+/g, ' ').trim();
        }
        if (!title && ld.title) title = ld.title;
        if (!company && ld.hiringOrganization) company = ld.hiringOrganization.name || '';
        if (!closingDate && ld.validThrough) {
          closingDate = new Date(ld.validThrough);
          if (isNaN(closingDate.getTime())) closingDate = null;
        }
      } catch (e) {}
    }
  }

  // Fallback: extract from HTML elements
  if (!title) {
    title = decode($('h1').first().text().trim());
  }
  if (!company) {
    company = decode($('.company-infos-title h2, .company-infos-title a, .company-name small').first().text().trim());
  }
  if (!description) {
    const bodyEl = $('.job-offer-body');
    if (bodyEl.length) {
      const $d = cheerio.load(bodyEl.html() || '');
      $d('script, style').remove();
      description = decode($d.text()).replace(/\s+/g, ' ').trim();
    }
  }

  // Extract structured info fields
  const infos = {};
  $('.job-offer-info').each((_, el) => {
    const key = $(el).find('.job-offer-info-title').text().trim();
    const val = $(el).find('.job-offer-info-value').text().trim();
    if (key && val) infos[key] = val;
  });

  // Determine contract type from infos
  let contractType = 'full-time';
  const contractVal = (infos['Type de contrat'] || infos['Contract type'] || '').toLowerCase();
  if (contractVal.includes('cdd') || contractVal.includes('fixed') || contractVal.includes('temporary')) contractType = 'fixed-term';
  else if (contractVal.includes('stage') || contractVal.includes('intern')) contractType = 'internship';
  else if (contractVal.includes('freelance') || contractVal.includes('independant')) contractType = 'freelance';
  else if (contractVal.includes('interim') || contractVal.includes('intérim')) contractType = 'temporary';

  const workTime = (infos['Temps de travail'] || infos['Working time'] || '').toLowerCase();
  if (workTime.includes('partiel') || workTime.includes('part')) contractType = 'part-time';

  // Location from infos or breadcrumb
  let location = infos['Localisation'] || infos['Location'] || '';
  if (!location) {
    // Try badges on detail page
    const locBadge = $('.badge.bg-primary-500').first().text().trim();
    if (locBadge) location = locBadge;
  }

  // Extract emails
  let emails = extractEmailsFromText(description);
  $('a[href^="mailto:"]').each((_, el) => {
    const mailtoHref = $(el).attr('href');
    if (mailtoHref) {
      const email = mailtoHref.replace('mailto:', '').split('?')[0].trim();
      if (email && email.includes('@')) emails.push(email);
    }
  });
  emails = [...new Set(emails)];

  // Apply link
  let applyLink = '';
  const applyBtn = $('a[href*="postuler"], a.btn-apply, a[href*="apply"]').first();
  if (applyBtn.length) {
    const href = applyBtn.attr('href');
    if (href && href.startsWith('http')) applyLink = href;
  }

  // Languages
  const languages = infos['Langues parlées'] || infos['Languages'] || '';

  return {
    title,
    company,
    description: description || '(No description available)',
    contractType,
    location,
    emails,
    closingDate,
    applyLink,
    languages,
  };
}

async function importJobsFromMoovijob() {
  await dbConnect();

  let stats = { processed: 0, saved: 0, emailsFound: 0, emailsSent: 0 };

  console.log('\nStarting Moovijob Luxembourg scraper (Puppeteer + Stealth)...');
  console.log(`Email sending ${process.env.SENDGRID_API_KEY ? 'ENABLED' : 'DISABLED (SENDGRID_API_KEY not configured)'}`);

  await JobModel.syncIndexes();

  const existingLinks = new Set(
    (await JobModel.find({}, 'relativeLink')).map((d) => d.relativeLink)
  );

  console.log('Launching headless browser...');
  const browser = await launchBrowser();

  try {
    // Fetch listing page
    console.log(`\nFetching job list: ${LIST_URL}`);
    const listHtml = await getPageHtml(browser, LIST_URL, '.card-job-offer-new');
    const $ = cheerio.load(listHtml);

    const cards = $('.card-job-offer-new');
    console.log(`Found ${cards.length} job cards on listing page`);

    if (cards.length === 0) {
      const pageTitle = $('title').text();
      console.log(`Page title: ${pageTitle}`);
      if (listHtml.includes('challenge') || listHtml.includes('turnstile')) {
        console.log('Cloudflare challenge detected. Stealth may not be sufficient.');
      }
    }

    // Collect job data from cards
    const jobEntries = [];
    cards.each((_, el) => {
      const card = parseListingCard($, el);
      if (card.href) {
        const relativeLink = normalizeLink(card.href);
        jobEntries.push({ ...card, relativeLink });
      }
    });

    // Deduplicate
    const seen = new Set();
    const uniqueJobs = jobEntries.filter((j) => {
      if (seen.has(j.relativeLink)) return false;
      seen.add(j.relativeLink);
      return true;
    });

    console.log(`Unique jobs to process: ${uniqueJobs.length}`);

    for (const job of uniqueJobs) {
      if (stats.processed >= 100) break;
      stats.processed++;

      if (existingLinks.has(job.relativeLink)) {
        console.log(`Skipping duplicate: ${job.relativeLink}`);
        continue;
      }

      // Fetch detail page
      let detail;
      try {
        const detailHtml = await getPageHtml(browser, `${BASE_URL}${job.relativeLink}`, '.job-offer-main-content');
        detail = parseDetailPage(detailHtml);
      } catch (err) {
        console.error(`Failed to fetch detail for ${job.relativeLink}:`, err.message);
        continue;
      }

      const title = detail.title || job.title || 'Untitled';
      const company = detail.company || job.company || 'Unknown Company';
      const description = detail.description;
      const contractType = detail.contractType;
      const location = detail.location || job.location || 'Luxembourg';
      const emails = detail.emails;
      const applyLink = detail.applyLink || `${BASE_URL}${job.relativeLink}`;
      const closingDate = detail.closingDate;

      if (emails && emails.length) {
        stats.emailsFound += emails.length;
        console.log(`Found ${emails.length} email(s) in job: ${title}`);
      }

      const id = uuidv4();
      const slug = generateSlug(title, company, id);

      let seniority = 'mid-level';
      const lowered = title.toLowerCase();
      if (lowered.includes('intern') || lowered.includes('stage') || lowered.includes('stagiaire') || lowered.includes('trainee')) seniority = 'intern';
      else if (lowered.includes('junior')) seniority = 'junior';
      else if (lowered.includes('senior') || lowered.includes('director') || lowered.includes('head of') || lowered.includes('directeur')) seniority = 'senior';

      let remote = 'no';
      const locLower = location.toLowerCase();
      if (locLower.includes('remote') || locLower.includes('télétravail')) remote = 'yes';
      else if (locLower.includes('hybrid') || locLower.includes('hybride')) remote = 'partial';

      // Tags from language info
      const tags = ['Luxembourg'];
      if (detail.languages) {
        detail.languages.split(/[,/]/).forEach((l) => {
          const trimmed = l.trim();
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
        contactEmail: emails && emails.length > 0 ? emails[0] : null,
        createdAt: new Date(),
        updatedAt: new Date(),
        expiresOn,
        seniority,
        plan: 'basic',
        source: 'moovijob',
      });

      try {
        await newJob.save();
        stats.saved++;
        existingLinks.add(job.relativeLink);
        console.log(`Saved: ${title} at ${company}`);

        if (process.env.SENDGRID_API_KEY && emails && emails.length > 0) {
          try {
            const emailSubject = 'Post your Luxembourg job with us for just 100 EUR';
            const emailContent = generateSalesEmailContent();
            const sentEmails = new Set();
            for (const email of emails) {
              if (sentEmails.has(email)) continue;
              const result = await sendEmail(email, emailSubject, emailContent, {
                jobTitle: title,
                companyName: company,
                source: 'moovijob',
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

importJobsFromMoovijob().catch((err) => {
  console.error('Unhandled error in Moovijob scraper:', err);
  mongoose.connection.close();
});
