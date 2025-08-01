const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000; // Vercel uses 3000 by default

// Middleware - Updated CORS configuration
app.use(cors({
  origin: [
    'https://coliving-activity-compass.vercel.app',
    'http://localhost:3000',
    'http://localhost:5173',
    process.env.FRONTEND_URL
  ].filter(Boolean), // Remove any undefined values
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// OAuth Configuration - Client Credentials Flow
const OAUTH_CONFIG = {
  clientId: process.env.OAUTH_CLIENT_ID,
  clientSecret: process.env.OAUTH_CLIENT_SECRET,
  tokenUrl: process.env.OAUTH_TOKEN_URL, // This is your RH_AUTH_URL
  baseUrl: process.env.API_BASE_URL // This is your RH_BASE_URL
};

// In-memory token storage
let tokenStorage = {
  accessToken: null,
  expiresAt: null
};

// Helper function to get access token using Client Credentials flow
async function getAccessToken() {
  try {
    const tokenData = {
      grant_type: 'client_credentials',
      client_id: OAUTH_CONFIG.clientId,
      client_secret: OAUTH_CONFIG.clientSecret
    };

    const response = await axios.post(OAUTH_CONFIG.tokenUrl, tokenData, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      }
    });

    const { access_token, expires_in } = response.data;
    
    // Store token with expiration
    tokenStorage.accessToken = access_token;
    tokenStorage.expiresAt = Date.now() + (expires_in * 1000);

    return access_token;
  } catch (error) {
    console.error('Error getting access token:', error.response?.data || error.message);
    throw error;
  }
}

// Helper function to get valid access token
async function getValidAccessToken() {
  // Check if token exists and is not expired
  if (tokenStorage.accessToken && tokenStorage.expiresAt > Date.now() + 300000) { // 5 minutes buffer
    return tokenStorage.accessToken;
  }

  // Get new token using client credentials
  try {
    return await getAccessToken();
  } catch (error) {
    console.error('Failed to get access token:', error.message);
    throw new Error('Authentication failed');
  }
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

// Test authentication endpoint
app.get('/auth/test', async (req, res) => {
  try {
    const accessToken = await getValidAccessToken();
    res.json({ 
      authenticated: true,
      message: 'Authentication successful',
      expiresAt: tokenStorage.expiresAt ? new Date(tokenStorage.expiresAt).toISOString() : null
    });
  } catch (error) {
    res.status(401).json({ 
      authenticated: false,
      error: error.message 
    });
  }
});

// Proxy API requests with authentication - FILTERED FOR CLEANING ACTIVITIES ONLY
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

    // Filter the results to only include "Inventory Check - Departure" activities
    const originalData = response.data;
    
    if (originalData && originalData.content && Array.isArray(originalData.content)) {
      const filteredContent = originalData.content.filter(activity => 
        activity.subject && activity.subject.includes('Inventory Check - Departure')
      );
      
      // Return the filtered response with updated metadata
      const filteredResponse = {
        ...originalData,
        content: filteredContent,
        numberOfElements: filteredContent.length,
        totalElements: filteredContent.length,
        // Keep original pagination info but note it's been filtered
        filtered: true,
        originalTotalElements: originalData.totalElements,
        filterCriteria: 'subject contains "Inventory Check - Departure"'
      };
      
      res.json(filteredResponse);
    } else {
      // If the response structure is unexpected, return as-is
      res.json(originalData);
    }
  } catch (error) {
    console.error('API request error:', error.response?.data || error.message);
    
    if (error.response?.status === 401) {
      res.status(401).json({ error: 'Authentication failed', requiresAuth: true });
    } else if (error.message === 'Authentication failed') {
      res.status(401).json({ error: 'Authentication failed', requiresAuth: true });
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

    // Check if this specific activity is a CLEANING activity
    const activity = response.data;
    if (activity && activity.activityType !== 'CLEANING') {
      res.status(404).json({ 
        error: 'Activity not found or not a cleaning activity',
        activityType: activity.activityType,
        filterCriteria: 'activityType=CLEANING'
      });
      return;
    }

    res.json(response.data);
  } catch (error) {
    console.error('API request error:', error.response?.data || error.message);
    
    if (error.response?.status === 401) {
      res.status(401).json({ error: 'Authentication failed', requiresAuth: true });
    } else if (error.message === 'Authentication failed') {
      res.status(401).json({ error: 'Authentication failed', requiresAuth: true });
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
      res.status(401).json({ error: 'Authentication failed', requiresAuth: true });
    } else if (error.message === 'Authentication failed') {
      res.status(401).json({ error: 'Authentication failed', requiresAuth: true });
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
  console.log(`🧹 Filtering for CLEANING activities only`);
  console.log(`🔐 OAuth Config Status:`);
  console.log(`   - Client ID: ${OAUTH_CONFIG.clientId ? '✅ Set' : '❌ Missing'}`);
  console.log(`   - Client Secret: ${OAUTH_CONFIG.clientSecret ? '✅ Set' : '❌ Missing'}`);
  console.log(`   - Token URL: ${OAUTH_CONFIG.tokenUrl || '❌ Missing'}`);
  console.log(`   - API Base URL: ${OAUTH_CONFIG.baseUrl || '❌ Missing'}`);
});
