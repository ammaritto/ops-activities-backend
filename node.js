const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000; // Vercel uses 3000 by default

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'https://your-frontend-domain.vercel.app',
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// OAuth Configuration
const OAUTH_CONFIG = {
  clientId: process.env.OAUTH_CLIENT_ID,
  clientSecret: process.env.OAUTH_CLIENT_SECRET,
  authUrl: process.env.OAUTH_AUTH_URL,
  tokenUrl: process.env.OAUTH_TOKEN_URL,
  redirectUri: process.env.OAUTH_REDIRECT_URI,
  scope: process.env.OAUTH_SCOPE || 'api/read api/write',
  baseUrl: process.env.API_BASE_URL
};

// In-memory token storage (in production, use Redis or database)
let tokenStorage = {
  accessToken: null,
  refreshToken: null,
  expiresAt: null
};

// Helper function to generate OAuth authorization URL
function generateAuthUrl() {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: OAUTH_CONFIG.clientId,
    redirect_uri: OAUTH_CONFIG.redirectUri,
    scope: OAUTH_CONFIG.scope,
    state: 'random_state_string' // In production, generate a secure random state
  });
  
  return `${OAUTH_CONFIG.authUrl}?${params.toString()}`;
}

// Helper function to exchange authorization code for tokens
async function exchangeCodeForTokens(code) {
  try {
    const tokenData = {
      grant_type: 'authorization_code',
      client_id: OAUTH_CONFIG.clientId,
      client_secret: OAUTH_CONFIG.clientSecret,
      code: code,
      redirect_uri: OAUTH_CONFIG.redirectUri
    };

    const response = await axios.post(OAUTH_CONFIG.tokenUrl, tokenData, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      }
    });

    const { access_token, refresh_token, expires_in } = response.data;
    
    // Store tokens
    tokenStorage.accessToken = access_token;
    tokenStorage.refreshToken = refresh_token;
    tokenStorage.expiresAt = Date.now() + (expires_in * 1000);

    return response.data;
  } catch (error) {
    console.error('Error exchanging code for tokens:', error.response?.data || error.message);
    throw error;
  }
}

// Helper function to refresh access token
async function refreshAccessToken() {
  try {
    if (!tokenStorage.refreshToken) {
      throw new Error('No refresh token available');
    }

    const tokenData = {
      grant_type: 'refresh_token',
      client_id: OAUTH_CONFIG.clientId,
      client_secret: OAUTH_CONFIG.clientSecret,
      refresh_token: tokenStorage.refreshToken
    };

    const response = await axios.post(OAUTH_CONFIG.tokenUrl, tokenData, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      }
    });

    const { access_token, refresh_token, expires_in } = response.data;
    
    // Update stored tokens
    tokenStorage.accessToken = access_token;
    if (refresh_token) {
      tokenStorage.refreshToken = refresh_token;
    }
    tokenStorage.expiresAt = Date.now() + (expires_in * 1000);

    return response.data;
  } catch (error) {
    console.error('Error refreshing token:', error.response?.data || error.message);
    throw error;
  }
}

// Helper function to get valid access token
async function getValidAccessToken() {
  // Check if token exists and is not expired
  if (tokenStorage.accessToken && tokenStorage.expiresAt > Date.now() + 300000) { // 5 minutes buffer
    return tokenStorage.accessToken;
  }

  // Try to refresh token
  if (tokenStorage.refreshToken) {
    try {
      await refreshAccessToken();
      return tokenStorage.accessToken;
    } catch (error) {
      console.error('Failed to refresh token:', error.message);
      // Clear invalid tokens
      tokenStorage = { accessToken: null, refreshToken: null, expiresAt: null };
      throw new Error('Authentication required');
    }
  }

  throw new Error('Authentication required');
}

// Routes

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    authenticated: !!tokenStorage.accessToken 
  });
});

// Get OAuth authorization URL
app.get('/auth/url', (req, res) => {
  try {
    const authUrl = generateAuthUrl();
    res.json({ authUrl });
  } catch (error) {
    console.error('Error generating auth URL:', error.message);
    res.status(500).json({ error: 'Failed to generate authorization URL' });
  }
});

// Handle OAuth callback
app.get('/auth/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.status(400).json({ error: `OAuth error: ${error}` });
    }

    if (!code) {
      return res.status(400).json({ error: 'Authorization code not provided' });
    }

    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(code);
    
    // Redirect to frontend with success
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    res.redirect(`${frontendUrl}?auth=success`);
  } catch (error) {
    console.error('OAuth callback error:', error.message);
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    res.redirect(`${frontendUrl}?auth=error&message=${encodeURIComponent(error.message)}`);
  }
});

// Check authentication status
app.get('/auth/status', (req, res) => {
  const isAuthenticated = !!(tokenStorage.accessToken && tokenStorage.expiresAt > Date.now());
  res.json({ 
    authenticated: isAuthenticated,
    expiresAt: tokenStorage.expiresAt ? new Date(tokenStorage.expiresAt).toISOString() : null
  });
});

// Logout endpoint
app.post('/auth/logout', (req, res) => {
  tokenStorage = { accessToken: null, refreshToken: null, expiresAt: null };
  res.json({ message: 'Logged out successfully' });
});

// Proxy API requests with authentication
app.get('/api/v3/activities', async (req, res) => {
  try {
    // Get valid access token
    const accessToken = await getValidAccessToken();

    // Build query parameters
    const queryParams = new URLSearchParams();
    
    // Default date range if not provided
    const dueDate = req.query.dueDate || '2015-11-02';
    const dueDateEnd = req.query.dueDateEnd || '2035-11-02';
    const page = req.query.page || '0';
    const size = req.query.size || '100';

    queryParams.append('dueDate', dueDate);
    queryParams.append('dueDateEnd', dueDateEnd);
    queryParams.append('page', page);
    queryParams.append('size', size);

    // Add any additional query parameters
    Object.keys(req.query).forEach(key => {
      if (!['dueDate', 'dueDateEnd', 'page', 'size'].includes(key)) {
        queryParams.append(key, req.query[key]);
      }
    });

    const apiUrl = `${OAUTH_CONFIG.baseUrl}/api/v3/activities?${queryParams.toString()}`;
    
    // Make request to external API
    const response = await axios.get(apiUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });

    res.json(response.data);
  } catch (error) {
    console.error('API request error:', error.response?.data || error.message);
    
    if (error.response?.status === 401) {
      res.status(401).json({ error: 'Authentication required', requiresAuth: true });
    } else if (error.message === 'Authentication required') {
      res.status(401).json({ error: 'Authentication required', requiresAuth: true });
    } else {
      res.status(error.response?.status || 500).json({ 
        error: error.response?.data?.message || error.message || 'Internal server error' 
      });
    }
  }
});

// Get specific activity by ID
app.get('/api/v3/activities/:id', async (req, res) => {
  try {
    const accessToken = await getValidAccessToken();
    const { id } = req.params;

    const apiUrl = `${OAUTH_CONFIG.baseUrl}/api/v3/activities/${id}`;
    
    const response = await axios.get(apiUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });

    res.json(response.data);
  } catch (error) {
    console.error('API request error:', error.response?.data || error.message);
    
    if (error.response?.status === 401) {
      res.status(401).json({ error: 'Authentication required', requiresAuth: true });
    } else if (error.message === 'Authentication required') {
      res.status(401).json({ error: 'Authentication required', requiresAuth: true });
    } else {
      res.status(error.response?.status || 500).json({ 
        error: error.response?.data?.message || error.message || 'Internal server error' 
      });
    }
  }
});

// Generic proxy for other API endpoints
app.use('/api/*', async (req, res) => {
  try {
    const accessToken = await getValidAccessToken();
    
    // Remove '/api' prefix and construct full URL
    const apiPath = req.originalUrl.replace('/api', '');
    const apiUrl = `${OAUTH_CONFIG.baseUrl}/api${apiPath}`;
    
    const config = {
      method: req.method,
      url: apiUrl,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    };

    if (['POST', 'PUT', 'PATCH'].includes(req.method.toUpperCase())) {
      config.data = req.body;
    }

    const response = await axios(config);
    res.status(response.status).json(response.data);
  } catch (error) {
    console.error('Generic API proxy error:', error.response?.data || error.message);
    
    if (error.response?.status === 401) {
      res.status(401).json({ error: 'Authentication required', requiresAuth: true });
    } else if (error.message === 'Authentication required') {
      res.status(401).json({ error: 'Authentication required', requiresAuth: true });
    } else {
      res.status(error.response?.status || 500).json({ 
        error: error.response?.data?.message || error.message || 'Internal server error' 
      });
    }
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Backend server running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  console.log(`🔐 OAuth Config Status:`);
  console.log(`   - Client ID: ${OAUTH_CONFIG.clientId ? '✅ Set' : '❌ Missing'}`);
  console.log(`   - Client Secret: ${OAUTH_CONFIG.clientSecret ? '✅ Set' : '❌ Missing'}`);
  console.log(`   - Auth URL: ${OAUTH_CONFIG.authUrl || '❌ Missing'}`);
  console.log(`   - Token URL: ${OAUTH_CONFIG.tokenUrl || '❌ Missing'}`);
  console.log(`   - API Base URL: ${OAUTH_CONFIG.baseUrl || '❌ Missing'}`);
});