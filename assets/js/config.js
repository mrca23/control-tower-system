// config.js - Configuration for J&T POD System (Final Fixed)
const CONFIG = {
  // FIX: Use origin so port is always correct (avoid 80/443 fallback bug)
  SERVER_URL: (() => {
    if (typeof window !== "undefined") {
      return window.location.origin;
    }
    return "http://localhost:3000";
  })(),

  // Admin PIN (client-side, untuk request admin)
  // NOTE: Aman untuk internal LAN; untuk production sebaiknya pindah ke login server-side
  ADMIN_PIN: "1234",

  // File upload settings
  MAX_FILE_SIZE: 5 * 1024 * 1024, // 5MB per foto
  MAX_FILES_PER_UPLOAD: 10,
  ALLOWED_FILE_TYPES: ["image/jpeg", "image/png", "image/jpg"],

  // Validation regex
  AWB_REGEX: /^[A-Z0-9]{5,30}$/i,

  // FIX: harus sama dengan server.js => /^LS\d{10}$/i
  SPRINTER_ID_REGEX: /^LS\d{10}$/i,

  // Image merge settings
  MERGE_CONFIG: {
    maxWidth: 1200,
    maxHeight: 800,
    spacing: 10,
    backgroundColor: "#ffffff",
    imageMaxHeight: 600,
  },

  // Session settings
  SESSION_CHECK_INTERVAL: 10 * 1000,

  // Auto refresh admin data
  AUTO_REFRESH_INTERVAL: 30 * 1000,
};

window.CONFIG = CONFIG;
