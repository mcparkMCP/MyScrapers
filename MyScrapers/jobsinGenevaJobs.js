const mongoose = require('mongoose');
const axios = require('axios');
const cheerio = require('cheerio');
const { decode } = require('html-entities');
const { v4: uuidv4 } = require('uuid');
const { JobModel } = require('./Job');
const dbConnect = require('./dbConnect');
const { sendEmail, extractEmailsFromText, generateSalesEmailContent } = require('./helperFunctions/emailUtils');
require('dotenv').config();

const BASE_URL = 'https://jobsingeneva.org';

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

/**
 * Resolve a value from the Nuxt payload positional array.
 * -1 means null. Arrays can be special types like ['Date', value].
 */
function resolveValue(data, idx) {
  if (idx === -1) return null;
  const val = data[idx];
  if (val === undefined) return null;
  if (Array.isArray(val)) {
    if (val[0] === 'Date') return val[1];
    if (val[0] === 'Set' || val[0] === 'Reactive' || val[0] === 'ShallowReactive') return null;
    // Array of indices — resolve each to its primitive
    return val.map((v) => (typeof v === 'number' ? data[v] : v));
  }
  return val;
}

/**
 * Fetch the Nuxt _payload.json and extract all job listings.
 */
async function fetchJobs() {
  // Step 1: Fetch homepage to get the payload URL hash
  const homepageRes = await axios.get(BASE_URL);
  const $ = cheerio.load(homepageRes.data);
  const dataSrc = $('#__NUXT_DATA__').attr('data-src');

  if (!dataSrc) {
    throw new Error('Could not find __NUXT_DATA__ payload URL on homepage');
  }

  // Step 2: Fetch the payload JSON
  const payloadUrl = `${BASE_URL}${dataSrc}`;
  const payloadRes = await axios.get(payloadUrl);
  const data = payloadRes.data;

  if (!Array.isArray(data) || data.length < 5) {
    throw new Error('Unexpected payload format');
  }

  // Step 3: Parse the Nuxt positional array
  // data[3] = { posts: <idx>, paidPosts: <idx> }
  const storiesObj = data[3];
  const postsArr = data[storiesObj.posts]; // array of indices to job objects
  const paidPostsArr = storiesObj.paidPosts !== undefined ? data[storiesObj.paidPosts] : [];

  // Combine free and paid posts
  const allPostIndices = [...(postsArr || []), ...(paidPostsArr || [])];

  const jobs = allPostIndices.map((idx) => {
    const template = data[idx]; // { id: N, title: N, employer: N, ... }
    const job = {};
    for (const [key, valIdx] of Object.entries(template)) {
      job[key] = resolveValue(data, valIdx);
    }
    return job;
  });

  return jobs;
}

async function importJobsFromJobsinGeneva() {
  await dbConnect();

  let stats = {
    processed: 0,
    saved: 0,
    emailsFound: 0,
    emailsSent: 0,
  };

  console.log('\nStarting JobsinGeneva scraper...');
  console.log(`Email sending ${process.env.SENDGRID_API_KEY ? 'ENABLED' : 'DISABLED (SENDGRID_API_KEY not configured)'}`);

  await JobModel.syncIndexes();

  const existingLinks = new Set(
    (await JobModel.find({}, 'relativeLink')).map((d) => d.relativeLink)
  );

  let jobs;
  try {
    jobs = await fetchJobs();
    console.log(`Found ${jobs.length} jobs in payload`);
  } catch (err) {
    console.error('Error fetching jobs:', err.message);
    await mongoose.connection.close();
    return;
  }

  for (const job of jobs) {
    stats.processed++;

    const jobId = job.id;
    if (!jobId) continue;

    // Use the job id as relativeLink for dedup
    const relativeLink = `/job/${jobId}`;

    if (existingLinks.has(relativeLink)) {
      console.log(`Skipping duplicate: ${relativeLink}`);
      continue;
    }

    const title = job.title || 'Untitled';
    const company = job.employer || 'Unknown Company';
    const description = job.description || '(No description available)';
    const applyLink = job.link || '';

    // Extract emails from description
    let emails = extractEmailsFromText(description);
    emails = [...new Set(emails)];
    if (emails.length) {
      stats.emailsFound += emails.length;
      console.log(`Found ${emails.length} email(s) in job: ${title}`);
    }

    // Determine contract type from employmentType array
    let contractType = 'full-time';
    const empTypes = job.employmentType || [];
    const empTypesLower = empTypes.map((t) => (t || '').toLowerCase());
    if (empTypesLower.some((t) => t.includes('intern') || t.includes('trainee'))) {
      contractType = 'internship';
    } else if (empTypesLower.some((t) => t.includes('contract') || t.includes('consultant'))) {
      contractType = 'consultant';
    } else if (empTypesLower.some((t) => t.includes('part-time') || t.includes('part time'))) {
      contractType = 'part-time';
    } else if (empTypesLower.some((t) => t.includes('temporary'))) {
      contractType = 'fixed-term';
    }

    // Tags from job_area and issue_category
    const tags = [
      ...(Array.isArray(job.job_area) ? job.job_area : []),
      ...(Array.isArray(job.issue_category) ? job.issue_category : []),
    ].filter(Boolean);

    // Remote detection
    let remote = 'no';
    if (empTypesLower.some((t) => t.includes('remote'))) {
      remote = 'yes';
    }

    // Seniority
    let seniority = 'mid-level';
    const lowered = title.toLowerCase();
    if (lowered.includes('intern') || lowered.includes('trainee')) seniority = 'intern';
    else if (lowered.includes('junior')) seniority = 'junior';
    else if (lowered.includes('senior')) seniority = 'senior';

    // Salary
    const salary = job.salary_monthly_min || 0;

    // Expiry
    const expiresOn = job.expiry
      ? new Date(job.expiry)
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const id = uuidv4();
    const slug = generateSlug(title, company, id);

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
      salary,
      city: 'Geneva',
      country: 'Switzerland',
      state: '',
      applyLink,
      relativeLink,
      contactEmail: emails.length > 0 ? emails[0] : null,
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresOn,
      seniority,
      plan: 'basic',
      source: 'jobsingeneva',
    });

    try {
      await newJob.save();
      stats.saved++;
      existingLinks.add(relativeLink);
      console.log(`Saved: ${title} at ${company}`);

      if (process.env.SENDGRID_API_KEY && emails.length > 0) {
        try {
          const emailSubject = 'Post your Geneva job with us for just CHF 50';
          const emailContent = generateSalesEmailContent();
          const sentEmails = new Set();
          for (const email of emails) {
            if (sentEmails.has(email)) continue;
            const result = await sendEmail(email, emailSubject, emailContent, {
              jobTitle: title,
              companyName: company,
              source: 'jobsingeneva',
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

importJobsFromJobsinGeneva().catch((err) => {
  console.error('Unhandled error in JobsinGeneva scraper:', err);
  mongoose.connection.close();
});
