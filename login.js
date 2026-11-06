'use strict';
const readline = require('readline');
const { launch } = require('./browser');

(async () => {
  const context = await launch({ headless: false });
  const page = context.pages()[0] || (await context.newPage());
  await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });

  console.log('\n👉 Connecte-toi à LinkedIn dans la fenêtre qui vient de s\'ouvrir (2FA / captcha compris).');
  console.log('   Quand tu vois ton fil d\'actualité, reviens ici et appuie sur Entrée.\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolve) => rl.question('Entrée pour terminer... ', () => { rl.close(); resolve(); }));

  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  const ok = /linkedin\.com\/feed/.test(page.url());
  console.log(ok ? '✅ Session enregistrée. Tu peux lancer : npm run dry' : '⚠️  Pas l\'air connecté, relance npm run login.');
  await context.close();
})();
