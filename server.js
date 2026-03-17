const express = require('express');
const session = require('express-session');
const OpenAI = require('openai');
const path = require('path');
const fs = require('fs');

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

// Helper to download image from URL using fetch
async function downloadImage(url, filepath) {
  console.log('Downloading image from:', url.substring(0, 100) + '...');

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(filepath, buffer);
  console.log('Image saved to:', filepath);
  return filepath;
}

// Ensure images directory exists
const imagesDir = path.join(__dirname, 'public', 'generated-images');
if (!fs.existsSync(imagesDir)) {
  fs.mkdirSync(imagesDir, { recursive: true });
}

// Generate blogs with Server-Sent Events for real-time progress
app.get('/api/generate-stream', requireAuth, async (req, res) => {
  const { apiKey, model, count, callsPerArticle, generateImages, imageModel, topics } = req.query;
  const shouldGenerateImages = generateImages === 'true';
  const selectedImageModel = imageModel || 'dall-e-3';

  console.log('=== SSE CONNECTION OPENED ===');
  console.log('Query params:', {
    model: req.query.model,
    count: req.query.count,
    callsPerArticle: req.query.callsPerArticle,
    generateImages: req.query.generateImages,
    imageModel: req.query.imageModel,
    hasApiKey: !!req.query.apiKey,
    hasTopics: !!req.query.topics
  });

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (event, data) => {
    console.log(`SSE Event: ${event}`, event === 'progress' ? data.message : '(data omitted)');
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Handle client disconnect
  req.on('close', () => {
    console.log('=== SSE CONNECTION CLOSED BY CLIENT ===');
  });

  try {
    if (!apiKey || !model || !count) {
      sendEvent('error', { error: 'Missing required fields' });
      return res.end();
    }

    const blogCount = Math.min(Math.max(parseInt(count), 1), 30);
    const depth = Math.min(Math.max(parseInt(callsPerArticle) || 2, 1), 5);
    console.log('=== GENERATION START ===');
    console.log('Config:', {
      model,
      blogCount,
      depth,
      shouldGenerateImages,
      selectedImageModel,
      hasTopics: !!topics
    });

    const openai = new OpenAI({ apiKey });
    const blogs = [];

    const totalSteps = blogCount * depth;
    let currentStep = 0;

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

    const topicContext = topics ? `Focus on these topics: ${topics}` : 'Focus on UI/UX design, mobile app design, app store optimization, conversion optimization, and design systems.';

    // Generate one blog at a time with multiple depth passes
    for (let blogIndex = 0; blogIndex < blogCount; blogIndex++) {
      sendEvent('progress', {
        message: `Creating article ${blogIndex + 1} of ${blogCount}...`,
        current: blogIndex,
        total: blogCount
      });

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

      console.log(`Article ${blogIndex + 1}: Initial generation...`);
      const articleStartTime = Date.now();

      try {
        const initialStartTime = Date.now();
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

        const rawResponse = initialCompletion.choices[0].message.content.trim();
        console.log(`Article ${blogIndex + 1}: Initial API response received (${Date.now() - initialStartTime}ms)`);
        console.log(`Article ${blogIndex + 1}: Raw response length: ${rawResponse.length} chars`);

        blogData = JSON.parse(rawResponse);
        console.log(`Article ${blogIndex + 1}: Parsed successfully - Title: "${blogData.title}"`);
        console.log(`Article ${blogIndex + 1}: Initial content length: ${blogData.content?.length || 0} chars`);
        currentStep++;
      } catch (err) {
        console.error(`=== ARTICLE ${blogIndex + 1} INITIAL ERROR ===`);
        console.error('Error:', err.message);
        console.error('Stack:', err.stack);
        if (err.response) {
          console.error('API Response:', JSON.stringify(err.response.data || err.response, null, 2));
        }
        sendEvent('progress', {
          message: `Article ${blogIndex + 1} failed, skipping...`,
          current: blogIndex,
          total: blogCount
        });
        continue;
      }

      // Additional passes to expand content
      for (let pass = 1; pass < depth; pass++) {
        sendEvent('progress', {
          message: `Expanding article ${blogIndex + 1} (pass ${pass + 1}/${depth})...`,
          current: blogIndex,
          total: blogCount
        });

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

        console.log(`Article ${blogIndex + 1}: Expansion pass ${pass + 1}/${depth}...`);
        const prevContentLength = blogData.content?.length || 0;
        const expansionStartTime = Date.now();

        try {
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

          const expanded = JSON.parse(expandCompletion.choices[0].message.content.trim());
          console.log(`Article ${blogIndex + 1}: Expansion ${pass + 1} received (${Date.now() - expansionStartTime}ms)`);

          if (expanded.content) {
            blogData.content = expanded.content;
            const newContentLength = blogData.content.length;
            console.log(`Article ${blogIndex + 1}: Content grew from ${prevContentLength} to ${newContentLength} chars (+${newContentLength - prevContentLength})`);
          } else {
            console.log(`Article ${blogIndex + 1}: Expansion ${pass + 1} returned no content field`);
          }
          currentStep++;
        } catch (err) {
          console.error(`=== ARTICLE ${blogIndex + 1} EXPANSION ${pass + 1} ERROR ===`);
          console.error('Error:', err.message);
          console.error('Stack:', err.stack);
          if (err.response) {
            console.error('API Response:', JSON.stringify(err.response.data || err.response, null, 2));
          }
        }
      }

      // Generate hero image if enabled
      if (shouldGenerateImages && blogData) {
        sendEvent('progress', {
          message: `Creating image for article ${blogIndex + 1}...`,
          current: blogIndex,
          total: blogCount
        });

        try {
          const imagePrompt = `Modern, minimalist abstract illustration representing "${blogData.title}". Clean geometric shapes, subtle gradients, professional design aesthetic. No text, no logos, no words, no letters. Soft teal and neutral color palette. Suitable as a blog hero image.`;

          console.log(`Article ${blogIndex + 1}: Generating image with ${selectedImageModel}...`);

          // Configure based on model
          let imageParams = {
            prompt: imagePrompt,
            n: 1
          };

          if (selectedImageModel === 'dall-e-3' || selectedImageModel === 'dall-e-3-hd') {
            imageParams.model = 'dall-e-3';
            imageParams.size = '1792x1024';
            imageParams.quality = selectedImageModel === 'dall-e-3-hd' ? 'hd' : 'standard';
          } else if (selectedImageModel === 'dall-e-2') {
            imageParams.model = 'dall-e-2';
            imageParams.size = '1024x1024';
          } else {
            // Default to DALL-E 3 for unknown models
            console.log(`Unknown image model ${selectedImageModel}, falling back to dall-e-3`);
            imageParams.model = 'dall-e-3';
            imageParams.size = '1792x1024';
            imageParams.quality = 'standard';
          }

          console.log('Image params:', JSON.stringify(imageParams, null, 2));
          const imageResponse = await openai.images.generate(imageParams);
          console.log('Image response received, URL length:', imageResponse.data[0]?.url?.length);

          const imageUrl = imageResponse.data[0].url;
          const imageName = `${blogData.slug}-${Date.now()}.png`;
          const imagePath = path.join(imagesDir, imageName);

          await downloadImage(imageUrl, imagePath);

          // Get the host from request headers for the URL
          const host = req.get('host');
          const protocol = req.get('x-forwarded-proto') || 'https';
          blogData.image = `${protocol}://${host}/generated-images/${imageName}`;

          console.log(`Article ${blogIndex + 1}: Image saved to ${imageName}`);
        } catch (imgErr) {
          console.error(`=== ARTICLE ${blogIndex + 1} IMAGE ERROR ===`);
          console.error('Model:', selectedImageModel);
          console.error('Error:', imgErr.message);
          console.error('Stack:', imgErr.stack);
          if (imgErr.response) {
            console.error('API Response:', JSON.stringify(imgErr.response.data || imgErr.response, null, 2));
          }
          blogData.image = '';
          sendEvent('progress', {
            message: `Image generation failed for article ${blogIndex + 1}, continuing...`,
            current: blogIndex,
            total: blogCount
          });
        }
      } else {
        blogData.image = '';
      }

      blogs.push(blogData);
      const articleTime = ((Date.now() - articleStartTime) / 1000).toFixed(1);
      console.log(`Article ${blogIndex + 1} complete (${depth} passes) in ${articleTime}s`);
      console.log(`Article ${blogIndex + 1} final content: ${blogData.content?.length || 0} chars, image: ${blogData.image ? 'yes' : 'no'}`);
      console.log(`Progress: ${blogs.length}/${blogCount} blogs generated`);

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

    console.log('=== GENERATION COMPLETE ===');
    console.log(`Total blogs: ${blogs.length}`);
    console.log('Blog titles:', blogs.map(b => b.title));
    console.log('Content lengths:', blogs.map(b => b.content?.length || 0));
    console.log('Images generated:', blogs.filter(b => b.image).length);

    console.log('=== GENERATING CSV ===');
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
    console.log(`CSV generated: ${csv.length} chars, ${csvRows.length} rows`);
    console.log('=== SENDING RESPONSE ===');

    sendEvent('complete', {
      success: true,
      blogs: blogs,
      csv: csv,
      count: blogs.length
    });

    res.end();

  } catch (error) {
    console.error('=== FATAL GENERATION ERROR ===');
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    if (error.response) {
      console.error('API Response:', JSON.stringify(error.response.data || error.response, null, 2));
    }
    sendEvent('error', { error: error.message || 'Failed to generate blogs' });
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Snackbar Blog Creator running on port ${PORT}`);
});
