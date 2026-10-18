// Vercel Web Analytics integration
// This file initializes Vercel Web Analytics for the koi pond project

// Import and inject Vercel Analytics
import { inject } from '../node_modules/@vercel/analytics/dist/index.mjs';

// Initialize analytics with automatic mode detection (production vs development)
inject({
  mode: 'auto' // Automatically detects development vs production based on environment
});
