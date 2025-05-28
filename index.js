const express = require('express');
const axios = require('axios');
const winston = require('winston');
const { LRUCache } = require('lru-cache');

const app = express();
const port = process.env.PORT || 3000;

// Middleware to parse JSON bodies
app.use(express.json());

// Middleware for input validation
const validateInput = (req, res, next) => {
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({
      error: 'Invalid or missing JSON body',
      details: ['Request body must be a valid JSON object. Ensure Content-Type: application/json is set.']
    });
  }
  const { apiToken, domain, zoneId } = req.body;
  const errors = [];
  if (!apiToken) errors.push('Missing required field: apiToken');
  if (!domain) errors.push('Missing required field: domain');
  if (!zoneId) errors.push('Missing required field: zoneId');
  // recordId is now optional

  if (errors.length > 0) {
    return res.status(400).json({
      error: 'Invalid input',
      details: errors
    });
  }
  next();
};

// Helper function to get client IP
const getClientIp = (req) => {
  return req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
};

// Configure Winston logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      return `${timestamp} [${level.toUpperCase()}] ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`;
    })
  ),
  transports: [
    new winston.transports.Console()
  ]
});

// LRU cache for last known IPs (max 500 entries, 5 min TTL)
const ipCache = new LRUCache({
  max: 5000,
  ttl: 1000 * 60 * 60 // 1 hour
});

// POST endpoint to update Cloudflare DNS
app.post('/', validateInput, async (req, res) => {
  const { apiToken, domain, zoneId, recordId } = req.body;

  // Get client public IP
  const clientIp = getClientIp(req);
  if (!clientIp) {
    return res.status(400).json({
      error: 'Could not determine client IP'
    });
  }

  // Cache key is zoneId + domain
  const cacheKey = `${zoneId}:${domain}`;
  if (ipCache.get(cacheKey) === clientIp) {
    logger.info('IP unchanged, skipping Cloudflare update', { domain, clientIp });
    return res.json({
      success: true,
      message: `IP for ${domain} ${clientIp}, no update needed.`
    });
  }

  try {
    // Configure Cloudflare API request
    const cloudflareApi = 'https://api.cloudflare.com/client/v4';
    const headers = {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json'
    };

    let dnsRecordId = recordId;
    // If recordId is not provided, fetch it
    if (!dnsRecordId) {
      const listResp = await axios.get(
        `${cloudflareApi}/zones/${zoneId}/dns_records?name=${encodeURIComponent(domain)}`,
        { headers }
      );
      if (listResp.data.success && listResp.data.result.length > 0) {
        dnsRecordId = listResp.data.result[0].id;
      } else {
        return res.status(404).json({
          error: 'DNS record not found for the specified domain',
          details: listResp.data.errors || []
        });
      }
    }

    // Prepare payload for Cloudflare API
    const payload = {
      type: 'A',
      name: domain,
      content: clientIp,
      ttl: 1, // Auto TTL
      proxied: false
    };

    // Log the payload being sent to Cloudflare (excluding apiToken and dnsRecordId)
    logger.info('Sending payload to Cloudflare', {
      payload,
      domain
    });

    // Update DNS record with new IP
    const response = await axios.put(
      `${cloudflareApi}/zones/${zoneId}/dns_records/${dnsRecordId}`,
      payload,
      { headers }
    );

    if (response.data.success) {
      // Update cache
      ipCache.set(cacheKey, clientIp);
      res.json({
        success: true,
        message: `DNS record for ${domain} updated to IP ${clientIp}`,
        data: response.data.result
      });
    } else {
      res.status(400).json({
        error: 'Cloudflare API error',
        details: response.data.errors
      });
    }
  } catch (error) {
    logger.error('Error updating DNS', { message: error.message, stack: error.stack, response: error.response?.data });
    console.error('Error updating DNS:', error.message);
    res.status(500).json({
      error: 'Failed to update DNS record',
      details: error.response?.data?.errors || error.message
    });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});