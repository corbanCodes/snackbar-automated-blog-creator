const express = require('express');
const session = require('express-session');
const OpenAI = require('openai');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// ============== Debug Logging ==============
const DEBUG = process.env.DEBUG !== 'false'; // Enable by default, disable with DEBUG=false

function log(category, message, data = null) {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${category}]`;
  if (data) {
    console.log(prefix, message, JSON.stringify(data, null, 2));
  } else {
    console.log(prefix, message);
  }
}

function logError(category, message, error) {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] [${category}] ERROR:`, message);
  if (error) {
    console.error(`[${timestamp}] [${category}] Error details:`, error.message);
    if (error.stack) {
      console.error(`[${timestamp}] [${category}] Stack:`, error.stack);
    }
    if (error.response?.data) {
      console.error(`[${timestamp}] [${category}] API Response:`, JSON.stringify(error.response.data, null, 2));
    }
  }
}

// Environment variables for auth
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'password';

// Job storage configuration
const DATA_DIR = path.join(__dirname, 'data', 'jobs');
const MAX_CONCURRENT_JOBS = 5;

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// In-memory tracking of running jobs (for background processing)
const runningJobs = new Map();

// ============== Job Storage Functions ==============

function saveJob(job) {
  const filePath = path.join(DATA_DIR, `${job.id}.json`);
  try {
    fs.writeFileSync(filePath, JSON.stringify(job, null, 2));
    log('STORAGE', `Job saved: ${job.id}`, { status: job.status, progress: job.progress?.message });
    return job;
  } catch (err) {
    logError('STORAGE', `Failed to save job ${job.id}`, err);
    throw err;
  }
}

function loadJob(jobId) {
  const filePath = path.join(DATA_DIR, `${jobId}.json`);
  log('STORAGE', `Loading job: ${jobId}`);
  if (!fs.existsSync(filePath)) {
    log('STORAGE', `Job not found: ${jobId}`);
    return null;
  }
  try {
    const job = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    log('STORAGE', `Job loaded: ${jobId}`, { status: job.status });
    return job;
  } catch (err) {
    logError('STORAGE', `Failed to load job ${jobId}`, err);
    return null;
  }
}

function listJobs() {
  log('STORAGE', `Listing jobs from: ${DATA_DIR}`);
  try {
    if (!fs.existsSync(DATA_DIR)) {
      log('STORAGE', 'Data directory does not exist, creating...');
      fs.mkdirSync(DATA_DIR, { recursive: true });
      return [];
    }
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
    log('STORAGE', `Found ${files.length} job files`);
    const jobs = files.map(f => {
      try {
        const job = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
        return {
          id: job.id,
          status: job.status,
          createdAt: job.createdAt,
          completedAt: job.completedAt,
          config: {
            model: job.config.model,
            count: job.config.count,
            generateImages: job.config.generateImages,
            imageModel: job.config.imageModel
          },
          progress: job.progress,
          error: job.error,
          resultCount: job.results?.count || 0
        };
      } catch (err) {
        logError('STORAGE', `Failed to parse job file: ${f}`, err);
        return null;
      }
    }).filter(Boolean);
    // Sort by creation date, newest first
    return jobs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } catch (err) {
    logError('STORAGE', 'Failed to list jobs', err);
    return [];
  }
}

function deleteJob(jobId) {
  const filePath = path.join(DATA_DIR, `${jobId}.json`);
  log('STORAGE', `Deleting job: ${jobId}`);
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
      log('STORAGE', `Job deleted: ${jobId}`);
      return true;
    } catch (err) {
      logError('STORAGE', `Failed to delete job ${jobId}`, err);
      return false;
    }
  }
  log('STORAGE', `Job not found for deletion: ${jobId}`);
  return false;
}

function getRunningJobCount() {
  const jobs = listJobs();
  const count = jobs.filter(j => j.status === 'running' || j.status === 'pending').length;
  log('STORAGE', `Running job count: ${count}`);
  return count;
}

// ============== Express Setup ==============

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Log all requests
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Serve static files EXCEPT index.html (protected)
app.use(express.static(path.join(__dirname, 'public'), {
  index: false
}));

app.use(session({
  secret: process.env.SESSION_SECRET || 'snackbar-blog-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// Auth middleware
function requireAuth(req, res, next) {
  if (req.session.authenticated) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

// Login page
app.get('/login', (req, res) => {
  if (req.session.authenticated) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Login handler
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    req.session.authenticated = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

// Logout
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Check auth status
app.get('/api/auth-status', (req, res) => {
  res.json({ authenticated: !!req.session.authenticated });
});

// Main dashboard
app.get('/', (req, res) => {
  if (!req.session.authenticated) {
    return res.redirect('/login');
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Model pricing info
const MODEL_PRICING = {
  'gpt-4o': { input: 2.50, output: 10.00, name: 'GPT-4o', description: 'Best quality, higher cost' },
  'gpt-4o-mini': { input: 0.15, output: 0.60, name: 'GPT-4o Mini', description: 'Great balance of quality and cost' },
  'gpt-4-turbo': { input: 10.00, output: 30.00, name: 'GPT-4 Turbo', description: 'High quality, premium pricing' },
  'gpt-3.5-turbo': { input: 0.50, output: 1.50, name: 'GPT-3.5 Turbo', description: 'Fastest, most economical' }
};

app.get('/api/models', requireAuth, (req, res) => {
  res.json(MODEL_PRICING);
});

// ============== Image Generation ==============

// Ensure images directory exists
const imagesDir = path.join(__dirname, 'public', 'generated-images');
if (!fs.existsSync(imagesDir)) {
  fs.mkdirSync(imagesDir, { recursive: true });
}

// Helper to download image from URL using fetch
async function downloadImage(url, filepath) {
  log('IMAGE', `Downloading image from: ${url.substring(0, 100)}...`);
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download image: ${response.status} ${response.statusText}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    log('IMAGE', `Downloaded ${buffer.length} bytes`);
    fs.writeFileSync(filepath, buffer);
    log('IMAGE', `Image saved to: ${filepath}`);
    return filepath;
  } catch (err) {
    logError('IMAGE', `Failed to download image`, err);
    throw err;
  }
}

// Generate image using DALL-E
async function generateDallEImage(openai, title, customPrompt, imageModel) {
  log('DALL-E', `Generating image for: "${title.substring(0, 50)}..."`);
  log('DALL-E', `Model: ${imageModel}, Custom prompt: ${customPrompt ? 'yes' : 'no'}`);

  const prompt = `Modern, minimalist abstract illustration representing "${title}". Clean geometric shapes, subtle gradients, professional design aesthetic. No text, no logos, no words, no letters. Soft teal and neutral color palette. ${customPrompt || ''} Suitable as a blog hero image.`;

  let imageParams = {
    prompt: prompt,
    n: 1
  };

  if (imageModel === 'dall-e-3' || imageModel === 'dall-e-3-hd') {
    imageParams.model = 'dall-e-3';
    imageParams.size = '1792x1024';
    imageParams.quality = imageModel === 'dall-e-3-hd' ? 'hd' : 'standard';
  } else if (imageModel === 'dall-e-2') {
    imageParams.model = 'dall-e-2';
    imageParams.size = '1024x1024';
  } else {
    imageParams.model = 'dall-e-3';
    imageParams.size = '1792x1024';
    imageParams.quality = 'standard';
  }

  log('DALL-E', `Image params:`, imageParams);

  try {
    const startTime = Date.now();
    const imageResponse = await openai.images.generate(imageParams);
    const duration = Date.now() - startTime;
    log('DALL-E', `Image generated in ${duration}ms, URL length: ${imageResponse.data[0]?.url?.length}`);
    return imageResponse.data[0].url;
  } catch (err) {
    logError('DALL-E', `Failed to generate image`, err);
    throw err;
  }
}

// Generate image using Nano Banana (Gemini)
async function generateNanoBananaImage(title, customPrompt, imageModel, geminiApiKey) {
  log('NANO-BANANA', `Generating image for: "${title.substring(0, 50)}..."`);
  log('NANO-BANANA', `Model: ${imageModel}, Custom prompt: ${customPrompt ? 'yes' : 'no'}`);
  log('NANO-BANANA', `API key provided: ${geminiApiKey ? 'yes (length: ' + geminiApiKey.length + ')' : 'no'}`);

  try {
    const { GoogleGenAI } = require('@google/genai');
    log('NANO-BANANA', 'GoogleGenAI module loaded');

    const ai = new GoogleGenAI({ apiKey: geminiApiKey });
    log('NANO-BANANA', 'GoogleGenAI client created');

    const prompt = `Modern, minimalist abstract illustration representing "${title}". Clean geometric shapes, subtle gradients, professional design aesthetic. No text, no logos, no words, no letters. Soft teal and neutral color palette. ${customPrompt || ''}`;

    // Use Imagen 4 for image generation (Imagen 3.0-001 was discontinued)
    const modelName = imageModel === 'nano-banana-pro'
      ? 'imagen-4.0-generate-001'
      : 'imagen-4.0-fast-generate-001';

    log('NANO-BANANA', `Using model: ${modelName}`);
    log('NANO-BANANA', `Prompt length: ${prompt.length} chars`);

    const startTime = Date.now();
    const response = await ai.models.generateImages({
      model: modelName,
      prompt: prompt,
      config: {
        numberOfImages: 1,
        aspectRatio: '16:9',
      }
    });
    const duration = Date.now() - startTime;
    log('NANO-BANANA', `API call completed in ${duration}ms`);
    log('NANO-BANANA', `Response keys: ${Object.keys(response || {}).join(', ')}`);

    // Extract the generated image
    const generatedImages = response.generatedImages;
    log('NANO-BANANA', `Generated images count: ${generatedImages?.length || 0}`);

    if (!generatedImages || generatedImages.length === 0) {
      log('NANO-BANANA', `Full response:`, response);
      throw new Error('No images generated from Nano Banana');
    }

    // Get base64 image data
    const imageData = generatedImages[0].image?.imageBytes;
    log('NANO-BANANA', `Image data present: ${imageData ? 'yes' : 'no'}`);

    if (!imageData) {
      log('NANO-BANANA', `First image object:`, generatedImages[0]);
      throw new Error('No image data in Nano Banana response');
    }

    const buffer = Buffer.from(imageData, 'base64');
    log('NANO-BANANA', `Image buffer size: ${buffer.length} bytes`);
    return buffer;
  } catch (err) {
    logError('NANO-BANANA', `Failed to generate image`, err);
    throw err;
  }
}

// ============== Job-Based API Endpoints ==============

// Create new generation job
app.post('/api/jobs', requireAuth, async (req, res) => {
  log('API', 'POST /api/jobs - Creating new job');
  log('API', 'Request body keys:', Object.keys(req.body));

  const { apiKey, geminiApiKey, model, count, callsPerArticle, generateImages, imageModel, imagePrompt, topics } = req.body;

  log('API', 'Job config:', {
    model,
    count,
    callsPerArticle,
    generateImages,
    imageModel,
    hasApiKey: !!apiKey,
    hasGeminiApiKey: !!geminiApiKey,
    hasTopics: !!topics,
    hasImagePrompt: !!imagePrompt
  });

  // Validate required fields
  if (!apiKey || !model || !count) {
    log('API', 'Validation failed: missing required fields');
    return res.status(400).json({ error: 'Missing required fields: apiKey, model, count' });
  }

  // Check for Gemini API key if using Nano Banana
  if (generateImages && (imageModel === 'nano-banana-2' || imageModel === 'nano-banana-pro') && !geminiApiKey) {
    log('API', 'Validation failed: missing Gemini API key for Nano Banana');
    return res.status(400).json({ error: 'Gemini API key required for Nano Banana image generation' });
  }

  // Check concurrent job limit
  const runningCount = getRunningJobCount();
  if (runningCount >= MAX_CONCURRENT_JOBS) {
    log('API', `Concurrent job limit reached: ${runningCount}/${MAX_CONCURRENT_JOBS}`);
    return res.status(429).json({ error: `Maximum ${MAX_CONCURRENT_JOBS} concurrent jobs allowed` });
  }

  const blogCount = Math.min(Math.max(parseInt(count), 1), 30);
  const depth = Math.min(Math.max(parseInt(callsPerArticle) || 2, 1), 5);

  // Create job
  const job = {
    id: uuidv4(),
    status: 'pending',
    createdAt: new Date().toISOString(),
    completedAt: null,
    config: {
      model,
      count: blogCount,
      callsPerArticle: depth,
      generateImages: !!generateImages,
      imageModel: imageModel || 'dall-e-3',
      imagePrompt: imagePrompt || '',
      topics: topics || ''
    },
    progress: {
      current: 0,
      total: blogCount,
      message: 'Starting generation...'
    },
    results: null,
    error: null
  };

  saveJob(job);
  log('API', `Job created: ${job.id}`);

  // Start background processing
  log('API', `Scheduling background processing for job: ${job.id}`);
  setImmediate(() => {
    log('API', `Background processing started for job: ${job.id}`);
    processJob(job.id, apiKey, geminiApiKey);
  });

  res.json({ jobId: job.id, status: 'pending' });
});

// List all jobs
app.get('/api/jobs', requireAuth, (req, res) => {
  log('API', 'GET /api/jobs - Listing all jobs');
  try {
    const jobs = listJobs();
    log('API', `Returning ${jobs.length} jobs`);
    res.json(jobs);
  } catch (err) {
    logError('API', 'Failed to list jobs', err);
    res.status(500).json({ error: 'Failed to list jobs' });
  }
});

// Get single job details
app.get('/api/jobs/:id', requireAuth, (req, res) => {
  const jobId = req.params.id;
  log('API', `GET /api/jobs/${jobId} - Getting job details`);
  try {
    const job = loadJob(jobId);
    if (!job) {
      log('API', `Job not found: ${jobId}`);
      return res.status(404).json({ error: 'Job not found' });
    }
    log('API', `Returning job: ${jobId}`, { status: job.status, hasResults: !!job.results });
    res.json(job);
  } catch (err) {
    logError('API', `Failed to get job ${jobId}`, err);
    res.status(500).json({ error: 'Failed to get job' });
  }
});

// Get job CSV download
app.get('/api/jobs/:id/csv', requireAuth, (req, res) => {
  const jobId = req.params.id;
  log('API', `GET /api/jobs/${jobId}/csv - Downloading CSV`);
  try {
    const job = loadJob(jobId);
    if (!job) {
      log('API', `Job not found: ${jobId}`);
      return res.status(404).json({ error: 'Job not found' });
    }
    if (job.status !== 'completed' || !job.results?.csv) {
      log('API', `Job not ready for CSV download: ${jobId}`, { status: job.status, hasCSV: !!job.results?.csv });
      return res.status(400).json({ error: 'Job not completed or no CSV available' });
    }

    log('API', `Sending CSV for job: ${jobId}`, { csvLength: job.results.csv.length });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=snackbar-blogs-${job.id.slice(0, 8)}.csv`);
    res.send(job.results.csv);
  } catch (err) {
    logError('API', `Failed to download CSV for job ${jobId}`, err);
    res.status(500).json({ error: 'Failed to download CSV' });
  }
});

// Cancel a running job
app.post('/api/jobs/:id/cancel', requireAuth, (req, res) => {
  const jobId = req.params.id;
  log('API', `POST /api/jobs/${jobId}/cancel - Cancelling job`);

  const job = loadJob(jobId);
  if (!job) {
    log('API', `Job not found: ${jobId}`);
    return res.status(404).json({ error: 'Job not found' });
  }

  if (job.status !== 'running' && job.status !== 'pending') {
    log('API', `Job not cancellable (status: ${job.status}): ${jobId}`);
    return res.status(400).json({ error: 'Job is not running' });
  }

  // Mark job as cancelled
  job.status = 'failed';
  job.error = 'Cancelled by user';
  job.completedAt = new Date().toISOString();
  saveJob(job);

  // Remove from running jobs map (will cause the processJob loop to stop)
  runningJobs.delete(jobId);

  log('API', `Job cancelled: ${jobId}`);
  res.json({ success: true });
});

// Delete job
app.delete('/api/jobs/:id', requireAuth, (req, res) => {
  const jobId = req.params.id;
  log('API', `DELETE /api/jobs/${jobId} - Deleting job`);

  // Check if job is running
  if (runningJobs.has(jobId)) {
    log('API', `Cannot delete running job: ${jobId}`);
    return res.status(400).json({ error: 'Cannot delete a running job' });
  }

  if (deleteJob(jobId)) {
    log('API', `Job deleted: ${jobId}`);
    res.json({ success: true });
  } else {
    log('API', `Job not found for deletion: ${jobId}`);
    res.status(404).json({ error: 'Job not found' });
  }
});

// SSE endpoint for live progress on specific job
app.get('/api/jobs/:id/stream', requireAuth, (req, res) => {
  const jobId = req.params.id;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Poll job status every second
  const interval = setInterval(() => {
    const job = loadJob(jobId);
    if (!job) {
      sendEvent({ error: 'Job not found' });
      clearInterval(interval);
      res.end();
      return;
    }

    sendEvent({
      status: job.status,
      progress: job.progress,
      error: job.error,
      completedAt: job.completedAt
    });

    if (job.status === 'completed' || job.status === 'failed') {
      clearInterval(interval);
      res.end();
    }
  }, 1000);

  req.on('close', () => {
    clearInterval(interval);
  });
});

// ============== Background Job Processing ==============

async function processJob(jobId, apiKey, geminiApiKey) {
  log('JOB', `=== PROCESS JOB START: ${jobId} ===`);

  const job = loadJob(jobId);
  if (!job) {
    logError('JOB', `Job ${jobId} not found for processing`);
    return;
  }

  // Mark as running
  job.status = 'running';
  job.progress.message = 'Starting generation...';
  saveJob(job);
  runningJobs.set(jobId, true);
  log('JOB', `Job ${jobId} marked as running, added to runningJobs map`);

  const { model, count, callsPerArticle, generateImages, imageModel, imagePrompt, topics } = job.config;

  log('JOB', `Job ${jobId} config:`, { model, count, callsPerArticle, generateImages, imageModel, hasTopics: !!topics });

  try {
    const openai = new OpenAI({ apiKey });
    const blogs = [];

    const systemPrompt = `You are a professional content writer for Snackbar Design (snackbar.design), a specialized UI/UX design agency focused on mobile app growth.

About Snackbar Design:
- Snackbar helps mobile app companies scale their creative production for app stores, in-app experiences, and marketing
- They specialize in ASO creative optimization, app store screenshots, preview videos, paywall design, and onboarding UX
- Notable clients include Adobe, Meta, eharmony, and Recorded Future
- They focus on high-volume creative production and multi-market localization

Writing style:
- Expert, practical, and performance-driven tone
- Write for VP Growth, ASO Managers, and Product leaders at growth-stage mobile app companies
- Include actionable insights and real-world examples
- Naturally reference Snackbar's expertise where relevant (not in every paragraph, but organically)

CRITICAL: You must return ONLY valid JSON. No markdown, no code blocks, no explanations.`;

    const topicContext = topics ? `Focus on these topics: ${topics}` : 'Focus on UI/UX design, mobile app design, app store optimization, conversion optimization, and design systems.';

    // Generate one blog at a time
    for (let blogIndex = 0; blogIndex < count; blogIndex++) {
      // Check if job was cancelled
      if (!runningJobs.has(jobId)) {
        log('JOB', `Job ${jobId} was cancelled, stopping processing`);
        return; // Exit without saving - job already marked as cancelled
      }

      // Update progress
      job.progress.current = blogIndex;
      job.progress.message = `Creating article ${blogIndex + 1} of ${count}...`;
      saveJob(job);

      let blogData = null;

      // First call: Generate the initial blog structure
      const initialPrompt = `Generate 1 professional blog post for Snackbar Design.

${topicContext}

Pick a unique topic that hasn't been covered yet. Provide:
1. title: A compelling, SEO-friendly title
2. slug: URL-friendly slug (lowercase, hyphens, no special characters)
3. blurb: A 1-2 sentence preview/description (max 160 characters)
4. content: Blog post in HTML format (800-1200 words for this first pass)

Content requirements:
- Use proper HTML tags: <h2>, <h3>, <p>, <ul>, <li>, <strong>, <em>
- Include 3-4 subheadings (h2/h3)
- Professional tone, actionable insights
- No markdown, only HTML
- Do not include the title in the content (it's separate)

Return as JSON:
{
  "title": "...",
  "slug": "...",
  "blurb": "...",
  "content": "<h2>...</h2><p>...</p>..."
}`;

      log('JOB', `Job ${jobId} - Article ${blogIndex + 1}/${count}: Initial generation starting...`);

      try {
        const startTime = Date.now();
        const initialCompletion = await openai.chat.completions.create({
          model: model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: initialPrompt }
          ],
          temperature: 0.7,
          max_tokens: 4000,
          response_format: { type: "json_object" }
        });
        const duration = Date.now() - startTime;

        const rawResponse = initialCompletion.choices[0].message.content.trim();
        log('JOB', `Job ${jobId} - Article ${blogIndex + 1}: OpenAI response received in ${duration}ms, length: ${rawResponse.length}`);

        blogData = JSON.parse(rawResponse);
        log('JOB', `Job ${jobId} - Article ${blogIndex + 1}: Parsed successfully - "${blogData.title}"`, {
          slug: blogData.slug,
          blurbLength: blogData.blurb?.length,
          contentLength: blogData.content?.length
        });
      } catch (err) {
        logError('JOB', `Job ${jobId} - Article ${blogIndex + 1} initial generation failed`, err);
        continue;
      }

      // Additional passes to expand content
      for (let pass = 1; pass < callsPerArticle; pass++) {
        log('JOB', `Job ${jobId} - Article ${blogIndex + 1}: Expansion pass ${pass + 1}/${callsPerArticle}`);
        job.progress.message = `Expanding article ${blogIndex + 1} (pass ${pass + 1}/${callsPerArticle})...`;
        saveJob(job);

        const prevContentLength = blogData.content?.length || 0;
        const expandPrompt = `Here is an existing blog post. Add 2-3 new sections to make it more comprehensive. Maintain the same style and flow.

EXISTING CONTENT:
Title: ${blogData.title}
${blogData.content}

Add new sections that:
- Dive deeper into practical implementation
- Include specific examples, case studies, or data points
- Add actionable tips or frameworks
- Reference Snackbar's expertise naturally where relevant

Return ONLY the complete updated content (including original + new sections) as JSON:
{
  "content": "<h2>...</h2><p>... full combined content with new sections ...</p>"
}`;

        try {
          const startTime = Date.now();
          const expandCompletion = await openai.chat.completions.create({
            model: model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: expandPrompt }
            ],
            temperature: 0.7,
            max_tokens: 6000,
            response_format: { type: "json_object" }
          });
          const duration = Date.now() - startTime;

          const expanded = JSON.parse(expandCompletion.choices[0].message.content.trim());
          if (expanded.content) {
            blogData.content = expanded.content;
            const newContentLength = blogData.content.length;
            log('JOB', `Job ${jobId} - Article ${blogIndex + 1}: Expansion ${pass + 1} complete in ${duration}ms`, {
              prevLength: prevContentLength,
              newLength: newContentLength,
              growth: newContentLength - prevContentLength
            });
          } else {
            log('JOB', `Job ${jobId} - Article ${blogIndex + 1}: Expansion ${pass + 1} returned no content`);
          }
        } catch (err) {
          logError('JOB', `Job ${jobId} - Article ${blogIndex + 1} expansion ${pass + 1} failed`, err);
        }
      }

      // Generate hero image if enabled
      if (generateImages && blogData) {
        log('JOB', `Job ${jobId} - Article ${blogIndex + 1}: Starting image generation`, { imageModel });
        job.progress.message = `Creating image for article ${blogIndex + 1}...`;
        saveJob(job);

        try {
          const isNanoBanana = imageModel === 'nano-banana-2' || imageModel === 'nano-banana-pro';
          const startTime = Date.now();

          if (isNanoBanana) {
            // Use Nano Banana (Gemini)
            log('JOB', `Job ${jobId} - Article ${blogIndex + 1}: Using Nano Banana for image`);
            const imageBuffer = await generateNanoBananaImage(blogData.title, imagePrompt, imageModel, geminiApiKey);
            const imageName = `${blogData.slug}-${Date.now()}.png`;
            const imagePath = path.join(imagesDir, imageName);
            log('JOB', `Job ${jobId} - Article ${blogIndex + 1}: Writing image to ${imagePath}`);
            fs.writeFileSync(imagePath, imageBuffer);
            blogData.image = `/generated-images/${imageName}`;
          } else {
            // Use DALL-E
            log('JOB', `Job ${jobId} - Article ${blogIndex + 1}: Using DALL-E for image`);
            const imageUrl = await generateDallEImage(openai, blogData.title, imagePrompt, imageModel);
            const imageName = `${blogData.slug}-${Date.now()}.png`;
            const imagePath = path.join(imagesDir, imageName);
            log('JOB', `Job ${jobId} - Article ${blogIndex + 1}: Downloading and saving image to ${imagePath}`);
            await downloadImage(imageUrl, imagePath);
            blogData.image = `/generated-images/${imageName}`;
          }

          const duration = Date.now() - startTime;
          log('JOB', `Job ${jobId} - Article ${blogIndex + 1}: Image saved in ${duration}ms`, { imagePath: blogData.image });
        } catch (imgErr) {
          logError('JOB', `Job ${jobId} - Article ${blogIndex + 1} image generation failed`, imgErr);
          blogData.image = '';
        }
      } else {
        log('JOB', `Job ${jobId} - Article ${blogIndex + 1}: Skipping image generation`);
        blogData.image = '';
      }

      blogs.push(blogData);
      log('JOB', `Job ${jobId} - Article ${blogIndex + 1}/${count} complete`, {
        title: blogData.title,
        contentLength: blogData.content?.length,
        hasImage: !!blogData.image
      });
    }

    if (blogs.length === 0) {
      log('JOB', `Job ${jobId}: No blogs generated, throwing error`);
      throw new Error('Failed to generate any blog posts');
    }

    log('JOB', `Job ${jobId}: All articles complete, generating CSV`);

    // Generate CSV
    const today = new Date();
    const dateStr = `${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}/${today.getFullYear()}`;
    const csvRows = [['title', 'slug', 'date', 'image', 'blurb', 'content'].join(',')];

    for (const blog of blogs) {
      const escapedContent = `"${blog.content.replace(/"/g, '""')}"`;
      const escapedBlurb = `"${blog.blurb.replace(/"/g, '""')}"`;
      const escapedTitle = `"${blog.title.replace(/"/g, '""')}"`;
      const imageUrl = blog.image || '';

      csvRows.push([
        escapedTitle,
        blog.slug,
        dateStr,
        imageUrl,
        escapedBlurb,
        escapedContent
      ].join(','));
    }

    const csv = csvRows.join('\n');
    log('JOB', `Job ${jobId}: CSV generated`, { rows: csvRows.length, csvLength: csv.length });

    // Mark job as completed
    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    job.progress.current = count;
    job.progress.message = `Generated ${blogs.length} blog posts`;
    job.results = {
      blogs,
      csv,
      count: blogs.length
    };
    saveJob(job);

    log('JOB', `=== JOB ${jobId} COMPLETE ===`, {
      blogsGenerated: blogs.length,
      withImages: blogs.filter(b => b.image).length,
      totalContentChars: blogs.reduce((sum, b) => sum + (b.content?.length || 0), 0)
    });

  } catch (error) {
    logError('JOB', `=== JOB ${jobId} FAILED ===`, error);

    job.status = 'failed';
    job.completedAt = new Date().toISOString();
    job.error = error.message;
    saveJob(job);
    log('JOB', `Job ${jobId} marked as failed`);
  } finally {
    runningJobs.delete(jobId);
    log('JOB', `Job ${jobId} removed from runningJobs map, current running: ${runningJobs.size}`);
  }
}

// ============== Legacy SSE Endpoint (kept for compatibility) ==============

app.get('/api/generate-stream', requireAuth, async (req, res) => {
  log('API', 'GET /api/generate-stream - Deprecated endpoint called');
  res.status(410).json({
    error: 'This endpoint is deprecated. Please use POST /api/jobs to create generation jobs.'
  });
});

// ============== Startup ==============

app.listen(PORT, () => {
  log('STARTUP', `=== Snackbar Blog Creator Starting ===`);
  log('STARTUP', `Port: ${PORT}`);
  log('STARTUP', `Data directory: ${DATA_DIR}`);
  log('STARTUP', `Images directory: ${imagesDir}`);
  log('STARTUP', `Max concurrent jobs: ${MAX_CONCURRENT_JOBS}`);
  log('STARTUP', `Node version: ${process.version}`);
  log('STARTUP', `Platform: ${process.platform}`);
  log('STARTUP', `Working directory: ${process.cwd()}`);

  // Check if directories exist
  log('STARTUP', `Data dir exists: ${fs.existsSync(DATA_DIR)}`);
  log('STARTUP', `Images dir exists: ${fs.existsSync(imagesDir)}`);

  // Count existing jobs
  try {
    const existingJobs = listJobs();
    const runningCount = existingJobs.filter(j => j.status === 'running' || j.status === 'pending').length;
    log('STARTUP', `Existing jobs: ${existingJobs.length} (${runningCount} running/pending)`);

    // Mark any "running" jobs as failed (server restart recovery)
    existingJobs.forEach(jobSummary => {
      if (jobSummary.status === 'running' || jobSummary.status === 'pending') {
        const job = loadJob(jobSummary.id);
        if (job) {
          log('STARTUP', `Recovering stale job: ${job.id} (was ${job.status})`);
          job.status = 'failed';
          job.error = 'Job interrupted by server restart';
          job.completedAt = new Date().toISOString();
          saveJob(job);
        }
      }
    });
  } catch (err) {
    logError('STARTUP', 'Failed to check existing jobs', err);
  }

  log('STARTUP', `=== Server ready on port ${PORT} ===`);
});
