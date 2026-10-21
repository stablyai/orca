// Monarch tokenizes an embedded language by mutual recursion: `_myTokenize`
// calls `_nestedTokenize` for every embed entered *mid-line*, which calls
// `_myTokenize` back for the rest of the line. Both calls are in tail position
// and V8 has no TCO, so JS stack use grows with the number of mid-line embed
// entries — one `<script>`, comment or `{expr}` each.
//
// These entries do not *nest*: monarchLexer throws "cannot enter embedded
// language from within an embedded language". They are sequential enter/exit
// transitions on one line, each leaving behind a frame pair that only returns
// once the line ends. Monaco only refuses lines at
// `MAX_TOKENIZATION_LINE_LENGTH`, which leaves room for thousands of them.
//
// Past the stack ceiling the `RangeError` is caught per line by Monaco's
// `safeTokenize`, so the line silently degrades to null tokens — it loses all
// highlighting rather than killing the renderer. `_findLeavingNestedLanguageOffset`
// also re-runs `line.search` over the line remainder at every level, so the
// cost is quadratic in transitions well before that.
//
// Guard: enter an embed only while the rest of the line fits this budget. Each
// entry consumes at least one character before the next, so the frame count can
// never exceed the budget. Longer lines keep tokenizing without the embed —
// coarser colours instead of a blank line. Worst case measured at this budget is
// 341 frames (a whole line of `{a}`), against a ~1000-frame ceiling in the same
// runtime.
//
// Not safe to halve: at 256 a realistic ~430-character Tailwind class attribute
// stops entering the html embed at every re-entry point, so ordinary markup
// loses attribute-level highlighting. Measured A/B on real-shaped SFCs.
export const EMBED_ENTRY_REST_OF_LINE_BUDGET = 512

// Monaco's own default for `editor.maxTokenizationLineLength`; longer lines are
// never tokenized at all. Pinned rather than inherited so the length this
// grammar's tests ramp to is the length a real editor will actually tokenize.
//
// This is NOT what bounds the recursion above: the shipped grammars overflowed
// at ~17_000 characters, well under this cap. `EMBED_ENTRY_REST_OF_LINE_BUDGET`
// is the guard — do not drop it on the strength of this constant.
export const MAX_TOKENIZATION_LINE_LENGTH = 20_000

const restOfLineWithinBudget = `(?!.{${EMBED_ENTRY_REST_OF_LINE_BUDGET + 1}})`

/** Zero-width: matches only while the rest of the line is within budget. */
export const restOfLineWithinEmbedBudget = new RegExp(restOfLineWithinBudget)

/** `>` (script/style tag close) followed by a within-budget rest of line. */
export const tagCloseWithinEmbedBudget = new RegExp(`>${restOfLineWithinBudget}`)
