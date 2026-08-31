/**
 * Deployment config. PUSH_SERVER_URL: origin of the deployed server that
 * relays push notifications (e.g. "https://rainbow.example.com"). Leave null
 * to disable push registration in the packaged mobile app.
 */
// Native pre-release builds use the Vercel push relay. iOS delivery requires
// matching APNs credentials and topic in that deployment.
export const PUSH_SERVER_URL = "https://bowcast.app";

// Aggregate funnel counters use the same first-party relay. Payloads contain
// only an allowlisted event name and broad app surface, never coordinates or
// identifiers.
export const METRICS_SERVER_URL = "https://bowcast.app";

// Anonymous calibration reports use the hosted Firestore-backed endpoint in
// packaged apps. The website uses its same-origin /api/sightings route.
export const SIGHTING_SERVER_URL = "https://bowcast.app";
