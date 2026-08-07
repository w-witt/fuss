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
  stripMetadataFootnotes,
  relocateFootnotes,
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

// --- stripMetadataFootnotes ---------------------------------------------------
{
  const seg = (text, segment_type = 'paragraph') => ({
    text,
    source_text: text,
    segment_type,
    index: 0,
  });
  const texts = (segs) => segs.map((s) => s.text);

  // The Sample PDF case: amsart front-matter footnotes land after the abstract.
  const out = stripMetadataFootnotes([
    seg('Abstract.', 'heading'),
    seg('We prove that a certain representation is not faithful.'),
    seg(
      'The author is supported by KIAS Individual Grant HP094701 at Korea Institute for Advanced Study.'
    ),
    seg('Key words and phrases. Baumslag-Gersten group; representation by functions.'),
    seg('2020 Mathematics Subject Classification. 20F05 (primary); 20F38 (secondary).'),
    seg('Let B be the Baumslag-Gersten group.'),
  ]);
  eq('metadata footnotes dropped', texts(out).join(' | '), [
    'Abstract.',
    'We prove that a certain representation is not faithful.',
    'Let B be the Baumslag-Gersten group.',
  ].join(' | '));

  // Keywords glued onto real prose: truncate, keep the prose.
  const merged = stripMetadataFootnotes([
    seg('This gives a negative answer to a problem of Olshanskii. Key words and phrases. groups; functions.'),
  ]);
  eq(
    'glued keywords truncated',
    texts(merged).join(''),
    'This gives a negative answer to a problem of Olshanskii.'
  );

  // Real prose about support must survive.
  const prose = stripMetadataFootnotes([
    seg('The claim is supported by the numerical evidence in Section 4.'),
  ]);
  eq('prose about support kept', prose.length, 1);
}

// --- relocateFootnotes --------------------------------------------------------
{
  const seg = (text, segment_type = 'paragraph') => ({
    text,
    source_text: text,
    segment_type,
    index: 0,
  });
  const texts = (segs) => segs.map((s) => s.text);

  // Referenced footnote splices in right after the citing segment.
  const spliced = relocateFootnotes([
    seg('Introduction', 'heading'),
    seg('The result was first observed by Gersten.1 It was later refined.'),
    seg('A second paragraph of prose.'),
    seg('Footnote 1: See the 1992 preprint for the original argument.'),
    seg('Closing paragraph.'),
  ]);
  eq('footnote spliced after reference', texts(spliced).join(' | '), [
    'Introduction',
    'The result was first observed by Gersten.1 It was later refined.',
    'Footnote 1: See the 1992 preprint for the original argument. End of footnote.',
    'A second paragraph of prose.',
    'Closing paragraph.',
  ].join(' | '));
  eq('spliced footnote typed', spliced[2].segment_type, 'footnote');

  // Unreferenced footnote defers to the end of its section.
  const deferred = relocateFootnotes([
    seg('Mid-page sentence one.'),
    seg('Footnote 2: An aside nobody visibly cites.'),
    seg('Mid-page sentence two.'),
    seg('Next Section', 'heading'),
    seg('Next section prose.'),
  ]);
  eq('unreferenced footnote deferred to section end', texts(deferred).join(' | '), [
    'Mid-page sentence one.',
    'Mid-page sentence two.',
    'Footnote 2: An aside nobody visibly cites. End of footnote.',
    'Next Section',
    'Next section prose.',
  ].join(' | '));

  // Dagger-marked footnote block, referenced by symbol.
  const dagger = relocateFootnotes([
    seg('The construction† follows the standard pattern.'),
    seg('More prose here.'),
    seg('† Due to Higman, in the countable case.'),
  ]);
  eq('dagger footnote spliced', texts(dagger).join(' | '), [
    'The construction† follows the standard pattern.',
    'Footnote †: Due to Higman, in the countable case. End of footnote.',
    'More prose here.',
  ].join(' | '));

  // A decimal like "3.5" must not count as a reference to footnote 5.
  const decimal = relocateFootnotes([
    seg('The constant is 3.5 in this regime.'),
    seg('Later prose.'),
    seg('Footnote 5: A genuinely unreferenced note.'),
  ]);
  eq(
    'decimal not a footnote ref',
    texts(decimal)[2],
    'Footnote 5: A genuinely unreferenced note. End of footnote.'
  );

  // Enumerated prose ("1. First do X") is not footnote-ish: bare numbers alone
  // never match, so nothing moves.
  const enumd = relocateFootnotes([seg('1) First do the reduction step.')]);
  eq('enumeration untouched', texts(enumd)[0], '1) First do the reduction step.');
}

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
