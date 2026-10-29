// Sequential mid-line embed transitions recurse without V8 TCO and rescan line tails quadratically. Bound entry by remaining line length to avoid silent stack-overflow/null tokens; 512 preserves realistic ~430-char Tailwind markup that a 256 cap degraded.
export const EMBED_ENTRY_REST_OF_LINE_BUDGET = 512

// Pin Monaco’s actual line-length ceiling for tests; it exceeds the ~17k overflow point and cannot replace the embed-entry budget.
export const MAX_TOKENIZATION_LINE_LENGTH = 20_000

const restOfLineWithinBudget = `(?!.{${EMBED_ENTRY_REST_OF_LINE_BUDGET + 1}})`

/** Zero-width: matches only while the rest of the line is within budget. */
export const restOfLineWithinEmbedBudget = new RegExp(restOfLineWithinBudget)

/** `>` (script/style tag close) followed by a within-budget rest of line. */
export const tagCloseWithinEmbedBudget = new RegExp(`>${restOfLineWithinBudget}`)
