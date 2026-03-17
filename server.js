const express = require('express');
const session = require('express-session');
const OpenAI = require('openai');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Environment variables for auth
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'password';

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
  console.log('Auth check:', { authenticated: req.session?.authenticated, path: req.path });
  if (req.session.authenticated) {
    next();
  } else {
    console.log('Auth rejected for:', req.path);
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

// Generate blogs with Server-Sent Events for real-time progress
app.get('/api/generate-stream', requireAuth, async (req, res) => {
  const { apiKey, model, count, topics } = req.query;

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    if (!apiKey || !model || !count) {
      sendEvent('error', { error: 'Missing required fields' });
      return res.end();
    }

    const blogCount = Math.min(Math.max(parseInt(count), 1), 30);
    console.log('Starting blog generation:', { model, count: blogCount });

    const openai = new OpenAI({ apiKey });
    const blogs = [];
    const batchSize = 2;
    const batches = Math.ceil(blogCount / batchSize);

    sendEvent('progress', { message: 'Starting generation...', current: 0, total: blogCount });

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

    for (let i = 0; i < batches; i++) {
      const currentBatchSize = Math.min(batchSize, blogCount - blogs.length);
      const topicContext = topics ? `Focus on these topics: ${topics}` : 'Focus on UI/UX design, mobile app design, app store optimization, conversion optimization, and design systems.';

      const prompt = `Generate ${currentBatchSize} professional blog post(s) for Snackbar Design.

${topicContext}

For each blog post, provide:
1. title: A compelling, SEO-friendly title
2. slug: URL-friendly slug (lowercase, hyphens, no special characters)
3. blurb: A 1-2 sentence preview/description (max 160 characters)
4. content: Full blog post in HTML format (1000-1500 words)

Content requirements:
- Use proper HTML tags: <h2>, <h3>, <p>, <ul>, <li>, <strong>, <em>
- Include 3-5 subheadings (h2/h3)
- Professional tone, actionable insights
- No markdown, only HTML
- Do not include the title in the content (it's separate)

Return as a JSON object with a "blogs" array:
{
  "blogs": [
    {
      "title": "...",
      "slug": "...",
      "blurb": "...",
      "content": "<h2>...</h2><p>...</p>..."
    }
  ]
}`;

      sendEvent('progress', {
        message: `Generating batch ${i + 1} of ${batches}...`,
        current: blogs.length,
        total: blogCount,
        batch: i + 1,
        totalBatches: batches
      });

      console.log(`Calling OpenAI API for batch ${i + 1}/${batches}...`);

      const completion = await openai.chat.completions.create({
        model: model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_tokens: 8000,
        response_format: { type: "json_object" }
      });

      console.log('OpenAI response received');
      const responseText = completion.choices[0].message.content.trim();

      let parsedBlogs;
      try {
        const parsed = JSON.parse(responseText);
        parsedBlogs = parsed.blogs || parsed;
        if (!Array.isArray(parsedBlogs)) {
          parsedBlogs = [parsedBlogs];
        }
      } catch (parseError) {
        console.error('Parse error:', parseError.message);
        sendEvent('progress', {
          message: `Batch ${i + 1} had parsing issues, continuing...`,
          current: blogs.length,
          total: blogCount
        });
        continue;
      }

      blogs.push(...parsedBlogs);
      console.log(`Batch complete: ${blogs.length}/${blogCount} blogs generated`);

      sendEvent('progress', {
        message: `Generated ${blogs.length} of ${blogCount} blogs`,
        current: blogs.length,
        total: blogCount
      });
    }

    if (blogs.length === 0) {
      sendEvent('error', { error: 'Failed to generate any blog posts. Please try again.' });
      return res.end();
    }

    console.log(`Generation complete: ${blogs.length} blogs total`);

    // Generate CSV
    const today = new Date();
    const dateStr = `${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}/${today.getFullYear()}`;

    const csvRows = [['title', 'slug', 'date', 'blurb', 'content'].join(',')];

    for (const blog of blogs) {
      const escapedContent = `"${blog.content.replace(/"/g, '""')}"`;
      const escapedBlurb = `"${blog.blurb.replace(/"/g, '""')}"`;
      const escapedTitle = `"${blog.title.replace(/"/g, '""')}"`;

      csvRows.push([
        escapedTitle,
        blog.slug,
        dateStr,
        escapedBlurb,
        escapedContent
      ].join(','));
    }

    const csv = csvRows.join('\n');

    sendEvent('complete', {
      success: true,
      blogs: blogs,
      csv: csv,
      count: blogs.length
    });

    res.end();

  } catch (error) {
    console.error('Generation error:', error.message);
    sendEvent('error', { error: error.message || 'Failed to generate blogs' });
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Snackbar Blog Creator running on port ${PORT}`);
});
