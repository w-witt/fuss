/** node web/aligner.test.mjs — sanity-checks the spoken→PDF aligner port. */
import { normalize, align } from './aligner.js';

let pass = 0,
  fail = 0;
const eq = (label, got, want) => {
  const a = JSON.stringify(got),
    b = JSON.stringify(want);
  if (a === b) pass++;
  else {
    fail++;
    console.log(`FAIL ${label}\n  got ${a}\n  want ${b}`);
  }
};

// normalize: lowercasing, symbol names, punctuation/diacritic stripping
eq('greek glyph', normalize('α'), 'alpha');
eq('punct strip', normalize('Hello,'), 'hello');
eq('accent strip', normalize('café'), 'cafe');
eq('leq glyph', normalize('≤'), 'lessthanorequal');

// align: spoken words land on the right PDF boxes, math verbalization included
const pdfWords = [
  { page: 1, x: 0, y: 0, w: 10, h: 5, str: 'The' },
  { page: 1, x: 12, y: 0, w: 10, h: 5, str: 'value' },
  { page: 1, x: 24, y: 0, w: 6, h: 5, str: 'α' },
  { page: 1, x: 32, y: 0, w: 10, h: 5, str: 'grows' },
];
const rects = align(['The', 'value', 'alpha', 'grows'], pdfWords);
eq('align len', rects.length, 4);
eq('align word0 page', rects[0] && rects[0].x, 0);
eq('align alpha→glyph box', rects[2] && rects[2].x, 24);
eq('align last', rects[3] && rects[3].x, 32);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
