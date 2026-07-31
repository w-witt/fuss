/**
 * Cross-checks the JS port against the Python pipeline's behaviour.
 * Run: node web/latex2text.test.mjs
 */
import {
  speakMath,
  applyTextRules,
  preprocessMmd,
  speakMathSpans,
  dedupeRepeats,
} from './latex2text.js';
import { lintMmd, lintLooksBad } from './mmdlint.js';

let pass = 0,
  fail = 0;
function eq(label, got, want) {
  if (got === want) {
    pass++;
  } else {
    fail++;
    console.log(`FAIL  ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`);
  }
}

// --- speakMath ---------------------------------------------------------------
eq('frac', speakMath('\\frac{a}{b}'), 'a over b');
eq('power n', speakMath('x^{n}'), 'x to the n');
eq('squared', speakMath('x^2'), 'x squared');
eq('inverse', speakMath('A^{-1}'), 'A inverse');
eq('sum', speakMath('\\sum x'), 'summation over x');
eq('sqrt', speakMath('\\sqrt{2}'), 'square root of 2');
eq('greek + leq', speakMath('\\alpha \\leq \\beta'), 'alpha less than or equal to beta');
eq('cdot', speakMath('a \\cdot b'), 'a times b');
eq('arithmetic', speakMath('a+b-c'), 'a plus b minus c');
eq('expectation', speakMath('\\mathbb{E}'), 'expectation');
eq('hat', speakMath('\\hat{x}'), 'x hat');
eq('in', speakMath('x \\in S'), 'x in S');
// replacements are space-wrapped, so stripped delimiters leave a word break
eq('strip braces/backslash', speakMath('\\foo{bar}'), 'foo bar');
// nested structures resolve innermost-first
eq(
  'nested frac in superscript',
  speakMath('x^{\\frac{1}{\\sqrt{2}}}'),
  'x to the 1 over square root of 2'
);
eq('nested sqrt in frac', speakMath('\\frac{\\sqrt{2}}{2}'), 'square root of 2 over 2');
eq('cong', speakMath('A \\cong B'), 'A is isomorphic to B');
eq(
  'rtimes',
  speakMath('\\mathbb{Z}\\rtimes\\mathbb{Z}'),
  'Z semidirect product with Z'
);
eq('not in', speakMath('a \\not\\in S'), 'a is not in S');
eq('log base', speakMath('\\log_{2}(x)'), 'log base 2 of (x)');

// --- applyTextRules ----------------------------------------------------------
eq('ie', applyTextRules('See i.e. this'), 'See that is this');
eq('eg', applyTextRules('e.g. that'), 'for example that');
eq('iid', applyTextRules('the iid samples'), 'the independent and identically distributed samples');
eq('Fig', applyTextRules('Fig. 3 shows'), 'Figure 3 shows');
eq('citation removal', applyTextRules('a result [12] holds'), 'a result holds');
eq('author-year removal', applyTextRules('shown (Smith, 2020) clearly'), 'shown clearly');
// spaced number lists are citations; unspaced ones are math and must survive
eq('paren citation removal', applyTextRules('a result (1, 2) holds'), 'a result holds');
eq('group argument kept', applyTextRules('the group BG(1,2) acts'), 'the group BG(1,2) acts');
eq('tuple kept', applyTextRules('a maps to (1,0) here'), 'a maps to (1,0) here');
eq('emphasis strip', applyTextRules('a *bold* word'), 'a bold word');
eq('wrt', applyTextRules('w.r.t. x'), 'with respect to x');

// --- dedupeRepeats (Nougat loop cropping) ------------------------------------
{
  const loop = ('The BG group is a subset of the BG group. '.repeat(20)).trim();
  const out = dedupeRepeats(loop);
  // The runaway loop collapses to a single sentence.
  eq('loop collapses', out, 'The BG group is a subset of the BG group.');
}
eq(
  'distinct sentences kept',
  dedupeRepeats('First claim here. Second different claim. Third one too.'),
  'First claim here. Second different claim. Third one too.'
);
eq('short text untouched', dedupeRepeats('Just one sentence.'), 'Just one sentence.');

// --- preprocessMmd -----------------------------------------------------------
eq(
  'dedupe consecutive lines',
  preprocessMmd('hello\nhello\nworld'),
  'hello\nworld'
);
eq(
  'table removal',
  preprocessMmd('a\\begin{table}junk\\end{table}b').includes('junk'),
  false
);

// --- speakMathSpans ----------------------------------------------------------
eq(
  'display span',
  speakMathSpans('text \\[x^2\\] more').replace(/\s+/g, ' ').trim(),
  'text x squared more'
);
eq(
  'inline dollar span',
  speakMathSpans('let $x \\leq y$ hold').replace(/\s+/g, ' ').trim(),
  'let x less than or equal to y hold'
);

// --- mmdlint (fidelity linter) ------------------------------------------------
{
  const clean = lintMmd('the map \\alpha\\colon A \\to B with \\frac{1}{2}');
  eq('lint: real commands pass', clean.unknown.length, 0);
  const dirty = lintMmd('so \\begindagger{tabular line} and \\multimd=x');
  eq(
    'lint: invented commands flagged',
    dirty.unknown.map((u) => u.command).join(','),
    '\\begindagger,\\multimd'
  );
  eq('lint: clean page not bad', lintLooksBad(clean), false);
  eq('lint: 3+ unknowns is bad', lintLooksBad({ total: 9, unknown: [1, 2, 3], badRatio: 0.33 }), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
