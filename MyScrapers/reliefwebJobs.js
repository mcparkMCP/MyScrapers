const mongoose = require('mongoose');
const axios = require('axios');
const cheerio = require('cheerio');
const { decode } = require('html-entities');
const { v4: uuidv4 } = require('uuid');
const { JobModel } = require('./Job');
const dbConnect = require('./dbConnect');
const { sendEmail, extractEmailsFromText, generateSalesEmailContent } = require('./helperFunctions/emailUtils');
require('dotenv').config();

const BASE_URL = 'https://reliefweb.int';
// C225 = Switzerland filter
const LIST_URL = `${BASE_URL}/jobs?advanced-search=%28C225%29`;

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

    // Try to extract structured data from JSON-LD
    let companyName = 'Unknown Company';
    let closingDate = null;
    const jsonLd = $('script[type="application/ld+json"]').first().html();
    if (jsonLd) {
      try {
        const structured = JSON.parse(jsonLd);
        if (structured.hiringOrganization && structured.hiringOrganization.name) {
          companyName = structured.hiringOrganization.name;
        }
        if (structured.validThrough) {
          closingDate = new Date(structured.validThrough);
        }
      } catch (e) {
        // JSON parse failed, continue with HTML extraction
      }
    }

    // Fallback: extract org from HTML meta
    if (companyName === 'Unknown Company') {
      const orgEl = $('.rw-entity-meta__tag-value--source a.rw-entity-meta__tag-link').first();
      if (orgEl.length) {
        companyName = decode(orgEl.text().trim());
      }
    }

    // Extract description
    let descriptionHtml = $('.rw-article__content').html() || '';
    const howToApplyHtml = $('.rw-how-to-apply').html() || '';
    if (howToApplyHtml) {
      descriptionHtml += '<br>' + howToApplyHtml;
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

    // Extract country from meta
    let country = 'Switzerland';
    const countryEl = $('.rw-entity-country-slug__link').first();
    if (countryEl.length) {
      country = decode(countryEl.text().trim());
    }

    // Extract career category as tags
    const tags = [];
    $('.rw-entity-meta__tag-value--career-category a.rw-entity-meta__tag-link').each((_, el) => {
      tags.push(decode($(el).text().trim()));
    });

    // Extract job type
    let jobType = 'full-time';
    const typeEl = $('.rw-entity-meta__tag-value--type a.rw-entity-meta__tag-link').first();
    if (typeEl.length) {
      const typeText = typeEl.text().toLowerCase();
      if (typeText.includes('consultancy')) jobType = 'consultant';
      else if (typeText.includes('internship')) jobType = 'internship';
    }

    return {
      description: cleaned || '(No description available)',
      companyName,
      emails,
      country,
      tags,
      jobType,
      closingDate,
    };
  } catch (err) {
    console.error(`Failed to fetch job detail: ${fullUrl}`, err.message);
    return {
      description: '',
      companyName: 'Unknown Company',
      emails: [],
      country: 'Switzerland',
      tags: [],
      jobType: 'full-time',
      closingDate: null,
    };
  }
}

async function importJobsFromReliefweb() {
  await dbConnect();

  let stats = {
    processed: 0,
    saved: 0,
    emailsFound: 0,
    emailsSent: 0,
  };

  console.log('\nStarting ReliefWeb Switzerland Jobs scraper...');
  console.log(`Email sending ${process.env.SENDGRID_API_KEY ? 'ENABLED' : 'DISABLED (SENDGRID_API_KEY not configured)'}`);

  await JobModel.syncIndexes();

  const existingLinks = new Set(
    (await JobModel.find({}, 'relativeLink')).map((d) => d.relativeLink)
  );

  let page = 0; // ReliefWeb uses zero-indexed pages
  let continuePaging = true;

  while (continuePaging && stats.processed < 200) {
    const pageUrl = page === 0
      ? LIST_URL
      : `${LIST_URL}&page=${page}`;
    console.log(`\nFetching job list page ${page + 1}: ${pageUrl}`);
    let res;
    try {
      res = await axios.get(pageUrl);
    } catch (err) {
      console.error(`Error fetching page ${page + 1}:`, err.message);
      break;
    }
    const $ = cheerio.load(res.data);
    const cards = $('article.rw-river-article--job');

    if (!cards || cards.length === 0) {
      console.log(`No job cards found on page ${page + 1}. Stopping.`);
      break;
    }

    for (let i = 0; i < cards.length && stats.processed < 200; i++) {
      stats.processed++;
      const card = cards[i];
      const titleEl = $(card).find('h3.rw-river-article__title a').first();
      const rawLink = titleEl.attr('href');
      if (!rawLink) continue;
      const relativeLink = normalizeLink(rawLink);

      if (existingLinks.has(relativeLink)) {
        console.log(`Skipping duplicate: ${relativeLink}`);
        continue;
      }

      const title = decode(titleEl.text().trim());

      // Extract org name from listing card as fallback
      let listingOrg = '';
      const orgEl = $(card).find('.rw-entity-meta__tag-value--source a.rw-entity-meta__tag-link').first();
      if (orgEl.length) {
        listingOrg = decode(orgEl.text().trim());
      }

      // Fetch detail page
      const {
        description,
        companyName: detailCompany,
        emails,
        country,
        tags,
        jobType,
        closingDate,
      } = await fetchJobDescription(relativeLink);

      const company = detailCompany !== 'Unknown Company' ? detailCompany : (listingOrg || 'Unknown Company');

      if (emails && emails.length) {
        stats.emailsFound += emails.length;
        console.log(`Found ${emails.length} email(s) in job: ${title}`);
      }

      const id = uuidv4();
      const slug = generateSlug(title, company, id);

      let seniority = 'mid-level';
      const lowered = title.toLowerCase();
      if (lowered.includes('intern')) seniority = 'intern';
      else if (lowered.includes('junior')) seniority = 'junior';
      else if (lowered.includes('senior')) seniority = 'senior';

      const expiresOn = closingDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      const newJob = new JobModel({
        _id: new mongoose.Types.ObjectId(),
        title,
        slug,
        description,
        companyName: company,
        sourceAgency: '',
        contractType: jobType,
        vacancyType: '',
        tags,
        remote: 'no',
        type: jobType,
        salary: 0,
        city: 'Geneva',
        country,
        state: '',
        applyLink: `${BASE_URL}${relativeLink}`,
        relativeLink,
        contactEmail: emails && emails.length > 0 ? emails[0] : null,
        createdAt: new Date(),
        updatedAt: new Date(),
        expiresOn,
        seniority,
        plan: 'basic',
        source: 'reliefweb',
      });

      try {
        await newJob.save();
        stats.saved++;
        existingLinks.add(relativeLink);
        console.log(`Saved: ${title}`);

        if (process.env.SENDGRID_API_KEY && emails && emails.length > 0) {
          try {
            const emailSubject = 'Post your job with us for just $100';
            const emailContent = generateSalesEmailContent();
            const sentEmails = new Set();
            for (const email of emails) {
              if (sentEmails.has(email)) continue;
              const result = await sendEmail(email, emailSubject, emailContent, {
                jobTitle: title,
                companyName: company,
                source: 'reliefweb',
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
    const nextPageLink = $(`a[href*="page=${page + 1}"]`);
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

importJobsFromReliefweb().catch((err) => {
  console.error('Unhandled error in ReliefWeb scraper:', err);
  mongoose.connection.close();
});
