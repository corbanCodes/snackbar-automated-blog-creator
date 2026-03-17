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

// Generate blogs
app.post('/api/generate', requireAuth, async (req, res) => {
  const { apiKey, model, count, topics } = req.body;

  if (!apiKey || !model || !count) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const blogCount = Math.min(Math.max(parseInt(count), 1), 30);

  try {
    const openai = new OpenAI({ apiKey });

    const blogs = [];
    const batchSize = 2;
    const batches = Math.ceil(blogCount / batchSize);

    for (let i = 0; i < batches; i++) {
      const currentBatchSize = Math.min(batchSize, blogCount - blogs.length);

      const topicContext = topics ? `Focus on these topics: ${topics}` : 'Focus on UI/UX design, mobile app design, app store optimization, conversion optimization, and design systems.';

      const prompt = `Generate ${currentBatchSize} professional blog post(s) for Snackbar Design, a UI/UX design agency specializing in mobile app design.

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

Return as JSON array:
[
  {
    "title": "...",
    "slug": "...",
    "blurb": "...",
    "content": "<h2>...</h2><p>...</p>..."
  }
]

Return ONLY the JSON array, no other text.`;

      const completion = await openai.chat.completions.create({
        model: model,
        messages: [
          { role: 'system', content: 'You are a professional content writer for a UI/UX design agency. Generate high-quality, SEO-optimized blog content. Always return valid JSON.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_tokens: 8000
      });

      const responseText = completion.choices[0].message.content.trim();

      // Parse JSON from response
      let parsedBlogs;
      try {
        // Try to extract JSON if wrapped in code blocks
        const jsonMatch = responseText.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          parsedBlogs = JSON.parse(jsonMatch[0]);
        } else {
          parsedBlogs = JSON.parse(responseText);
        }
      } catch (parseError) {
        console.error('Parse error:', parseError);
        console.error('Response:', responseText);
        continue;
      }

      blogs.push(...parsedBlogs);
    }

    // Generate CSV
    const today = new Date();
    const dateStr = `${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}/${today.getFullYear()}`;

    const csvRows = [
      ['title', 'slug', 'date', 'blurb', 'content'].join(',')
    ];

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

    res.json({
      success: true,
      blogs: blogs,
      csv: csv,
      count: blogs.length
    });

  } catch (error) {
    console.error('Generation error:', error);
    res.status(500).json({
      error: error.message || 'Failed to generate blogs',
      details: error.response?.data || null
    });
  }
});

app.listen(PORT, () => {
  console.log(`Snackbar Blog Creator running on port ${PORT}`);
});
