/**
 * Generate the SHA-256 hash for an invite code, to paste into gate.js.
 *
 *   node gen-code.mjs "FUSS-NEW-CODE"      # hash one code
 *   node gen-code.mjs                       # invent a random code + hash
 */
import { createHash, randomBytes } from 'node:crypto';

function randomCode() {
  const b = randomBytes(4).toString('hex').toUpperCase();
  return `FUSS-${b.slice(0, 4)}-${b.slice(4, 8)}`;
}

const code = (process.argv[2] || randomCode()).trim().toUpperCase();
const hash = createHash('sha256').update(code).digest('hex');

console.log(`code:  ${code}`);
console.log(`hash:  ${hash}`);
console.log(`\nAdd the hash to ALLOWED_CODE_HASHES in gate.js, and give "${code}" to a tester.`);
