/** SessionStart sources that begin a new Claude session in the pane; Claude 2.1.214+ reports a
 *  `--fork-session` start as `fork` where it used to say `resume`. Compaction and children are absent. */
export const CLAUDE_NEW_SESSION_START_SOURCES: ReadonlySet<unknown> = new Set([
  'startup',
  'resume',
  'fork',
  'clear'
])
