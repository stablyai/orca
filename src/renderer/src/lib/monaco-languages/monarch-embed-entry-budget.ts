// Monarch tokenizes an embedded language by mutual recursion: `_myTokenize`
// calls `_nestedTokenize` for every embed entered *mid-line*, which calls
// `_myTokenize` back for the rest of the line. Both calls are in tail position
// and V8 has no TCO, so JS stack depth grows with the number of mid-line embed
// entries — one `<script>`, comment or `{expr}` each. Monaco only refuses lines
// at `editor.maxTokenizationLineLength` (20_000), which leaves room for
// thousands of entries and a renderer-killing STATUS_STACK_OVERFLOW.
//
// Guard: enter an embed only while the rest of the line fits this budget. Each
// entry consumes at least one character before the next, so depth can never
// exceed the budget. Longer lines keep tokenizing without the embed — coarser
// colours instead of a dead renderer. Worst case measured at this budget is 341
// levels (a whole line of `{a}`), against a ~1000-level ceiling in the same
// runtime.
//
// Not safe to halve: at 256 a realistic ~430-character Tailwind class attribute
// stops entering the html embed at every re-entry point, so ordinary markup
// loses attribute-level highlighting. Measured A/B on real-shaped SFCs.
export const EMBED_ENTRY_REST_OF_LINE_BUDGET = 512

const restOfLineWithinBudget = `(?!.{${EMBED_ENTRY_REST_OF_LINE_BUDGET + 1}})`

/** Zero-width: matches only while the rest of the line is within budget. */
export const restOfLineWithinEmbedBudget = new RegExp(restOfLineWithinBudget)

/** `>` (script/style tag close) followed by a within-budget rest of line. */
export const tagCloseWithinEmbedBudget = new RegExp(`>${restOfLineWithinBudget}`)
