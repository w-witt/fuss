/**
 * Cross-checks the JS port against the Python pipeline's behaviour.
 * Run: node web/latex2text.test.mjs
 */
import { speakMath, applyTextRules, preprocessMmd, speakMathSpans } from './latex2text.js';

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

// --- applyTextRules ----------------------------------------------------------
eq('ie', applyTextRules('See i.e. this'), 'See that is this');
eq('eg', applyTextRules('e.g. that'), 'for example that');
eq('iid', applyTextRules('the iid samples'), 'the independent and identically distributed samples');
eq('Fig', applyTextRules('Fig. 3 shows'), 'Figure 3 shows');
eq('citation removal', applyTextRules('a result [12] holds'), 'a result holds');
eq('author-year removal', applyTextRules('shown (Smith, 2020) clearly'), 'shown clearly');
eq('emphasis strip', applyTextRules('a *bold* word'), 'a bold word');
eq('wrt', applyTextRules('w.r.t. x'), 'with respect to x');

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
