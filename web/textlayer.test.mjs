/**
 * Unit tests for the text-layer extractor (geometry → MMD).
 * Run: node web/textlayer.test.mjs
 */
import { extractPageMmd } from './textlayer.js';

let pass = 0,
  fail = 0;
function check(label, cond, got) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log(`FAIL  ${label}\n   got:  ${JSON.stringify(got)}`);
  }
}

// pdf.js-like text item: baseline at (x, y), font size s.
const it = (str, x, y, s, fontName = 'f_text', width = null) => ({
  str,
  transform: [s, 0, 0, s, x, y],
  width: width ?? str.length * s * 0.5,
  fontName,
});
const page = (items) => ({ items, styles: {} });
const FONTS = { f_mi: 'ABCDEF+CMMI10', f_sy: 'ABCDEF+CMSY7', f_text: 'ABCDEF+CMR10' };

// --- inline exponent: b a b then superscript "−1" as two small items --------
{
  const res = extractPageMmd(
    page([
      it('The element ', 50, 700, 10),
      it('bab', 110, 700, 10, 'f_mi', 18),
      it('−', 128, 703.5, 7, 'f_sy', 5),
      it('1', 133, 703.5, 7, 'f_text', 4),
      it(' is central.', 140, 700, 10),
    ]),
    { fontNames: FONTS }
  );
  check('exponent merges into ^{-1}', /bab\^\{\s?-\s?1\}/.test(res.mmd), res.mmd);
  check('exponent stays in one math span', !/\^\{[^}]*\\\(/.test(res.mmd), res.mmd);
}

// --- footnote marker: small raised digit after prose stays glued ------------
{
  const res = extractPageMmd(
    page([
      it('as shown before.', 50, 700, 10, 'f_text', 80),
      it('3', 130, 703.5, 7, 'f_text', 4),
      it('More prose follows here.', 140, 700, 10, 'f_text', 120),
    ]),
    { fontNames: FONTS }
  );
  check('footnote marker glued', res.mmd.includes('before.3'), res.mmd);
  check('footnote marker not math', !res.mmd.includes('^{3}'), res.mmd);
}

// --- Greek + symbol mapping -------------------------------------------------
{
  const res = extractPageMmd(
    page([it('for all ', 50, 700, 10), it('α ≤ β', 100, 700, 10, 'f_mi', 30), it(' we have', 132, 700, 10)]),
    { fontNames: FONTS }
  );
  check('greek mapped', res.mmd.includes('\\alpha'), res.mmd);
  check('leq mapped', res.mmd.includes('\\leq'), res.mmd);
  check('math span wrapped', /\\\(.*\\alpha.*\\\)/.test(res.mmd), res.mmd);
}

// --- rotated watermark dropped ---------------------------------------------
{
  const res = extractPageMmd(
    page([
      { str: 'arXiv:2606.27408v1', transform: [0, 10, -10, 0, 20, 400], width: 90, fontName: 'f_text' },
      it('Real prose line here.', 50, 700, 10, 'f_text', 110),
    ]),
    { fontNames: FONTS }
  );
  check('rotated text dropped', !res.mmd.includes('arXiv'), res.mmd);
  check('prose kept', res.mmd.includes('Real prose line here.'), res.mmd);
}

// --- running head removed on later pages ------------------------------------
{
  const items = [
    it('A PROBLEM OF OLSHANSKII', 200, 770, 10, 'f_text', 130),
    it('Body text continues with a sentence.', 50, 700, 10, 'f_text', 180),
    it('More body text on the same page follows.', 50, 688, 10, 'f_text', 200),
  ];
  const res2 = extractPageMmd(page(items), { fontNames: FONTS, pageIndex: 1 });
  check('running head dropped on page 2', !res2.mmd.includes('OLSHANSKII'), res2.mmd);
  const res1 = extractPageMmd(page(items), { fontNames: FONTS, pageIndex: 0 });
  check('same line kept on page 1', res1.mmd.includes('OLSHANSKII'), res1.mmd);
}

// --- title heading on page 1 ------------------------------------------------
{
  const res = extractPageMmd(
    page([
      it('A GREAT THEOREM', 150, 750, 14, 'f_text', 120),
      it('First paragraph of the body, long enough to be body text.', 50, 700, 10, 'f_text', 280),
      it('Second line of the body paragraph continues here nicely.', 50, 688, 10, 'f_text', 280),
    ]),
    { fontNames: FONTS, pageIndex: 0 }
  );
  check('title promoted to heading', /^# A GREAT THEOREM/m.test(res.mmd), res.mmd);
}

// --- empty / scanned page ----------------------------------------------------
{
  const res = extractPageMmd(page([]), {});
  check('no text layer → hasText false', res.hasText === false, res);
}

// --- stacked fraction lowers confidence --------------------------------------
{
  const base = [
    it('The value equals', 50, 700, 10, 'f_text', 90),
    it('x + 1', 150, 703, 10, 'f_mi', 25), // numerator
    it('2', 158, 693, 10, 'f_text', 5), // denominator, overlapping x, tiny gap
    it('as claimed in the theorem.', 200, 700, 10, 'f_text', 130),
  ];
  const res = extractPageMmd(page(base), { fontNames: FONTS });
  const clean = extractPageMmd(
    page([it('Just prose here, nothing stacked at all.', 50, 700, 10, 'f_text', 200)]),
    { fontNames: FONTS }
  );
  check('stacked construct penalized', res.confidence < clean.confidence, {
    stacked: res.confidence,
    clean: clean.confidence,
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
