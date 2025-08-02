const express = require('express');

// In-memory storage (will reset on deployment, but works for testing)
let depositsData = {};

// Create router for deposit-related endpoints
const router = express.Router();

// GET /api/activity-deposits - Get deposit status for a specific activity
router.get('/activity-deposits', (req, res) => {
  try {
    const { activityId } = req.query;

    if (!activityId) {
      return res.status(400).json({ error: 'Activity ID is required' });
    }

    // Get deposit status for the activity or return defaults
    const activityDeposits = depositsData[activityId] || {
      depositReturnComplete: false,
      depositTransferredToNewStudio: false
    };
    
    console.log(`GET deposits for activity ${activityId}:`, activityDeposits);
    res.status(200).json(activityDeposits);
  } catch (error) {
    console.error('Error getting deposit status:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
});

// PUT /api/activity-deposits - Update deposit status for a specific activity
router.put('/activity-deposits', (req, res) => {
  try {
    const { activityId } = req.query;
    const { depositReturnComplete, depositTransferredToNewStudio } = req.body;

    if (!activityId) {
      return res.status(400).json({ error: 'Activity ID is required' });
    }
    
    if (typeof depositReturnComplete !== 'boolean' || typeof depositTransferredToNewStudio !== 'boolean') {
      return res.status(400).json({ 
        error: 'Both depositReturnComplete and depositTransferredToNewStudio must be boolean values' 
      });
    }

    // Store in memory
    depositsData[activityId] = {
      depositReturnComplete,
      depositTransferredToNewStudio,
      updatedAt: new Date().toISOString()
    };

    console.log(`PUT deposits for activity ${activityId}:`, depositsData[activityId]);
    
    res.status(200).json({
      message: 'Deposit status updated successfully',
      data: depositsData[activityId]
    });
  } catch (error) {
    console.error('Error updating deposit status:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
});

module.exports = router;
