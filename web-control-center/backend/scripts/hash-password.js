#!/usr/bin/env node
import { createPasswordHash } from '../auth.js';

const password = process.argv[2];

if (!password) {
  console.error('Uso: npm run hash-password -- "sua-senha"');
  process.exit(1);
}

if (password.length < 12) {
  console.error('A senha deve ter pelo menos 12 caracteres.');
  process.exit(1);
}

const hash = await createPasswordHash(password);

console.log('\nAdicione ao seu .env:\n');
console.log(`WEB_AUTH_PASSWORD_HASH=${hash}\n`);
