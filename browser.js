'use strict';
const path = require('path');
const { chromium } = require('playwright');

const PROFILE_DIR = path.join(__dirname, '.browser-profile');

// Profil persistant = ta session LinkedIn reste enregistrée entre deux lancements.
// On essaie d'abord ton vrai Google Chrome (moins détectable), sinon le Chromium de Playwright.
async function launch({ headless = false } = {}) {
  const opts = {
    headless,
    viewport: { width: 1366, height: 860 },
    locale: 'fr-FR',
    args: ['--disable-blink-features=AutomationControlled'],
  };
  try {
    return await chromium.launchPersistentContext(PROFILE_DIR, { ...opts, channel: 'chrome' });
  } catch (e) {
    return await chromium.launchPersistentContext(PROFILE_DIR, opts);
  }
}

module.exports = { launch, PROFILE_DIR };
