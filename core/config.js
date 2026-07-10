/**
 * Deployment config. PUSH_SERVER_URL: origin of the deployed server that
 * relays push notifications (e.g. "https://rainbow.example.com"). Leave null
 * to disable push registration in the packaged mobile app.
 */
// Dev value: this Mac on the local network (phone must be on the same Wi-Fi).
// Replace with the deployed server origin for production, or null to disable.
export const PUSH_SERVER_URL = "http://10.0.68.30:3000";
