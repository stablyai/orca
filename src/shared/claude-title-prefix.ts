/**
 * Claude Code title-prefix identity primitives.
 *
 * Why a dedicated module: Claude Code prefixes its OSC title with a status
 * glyph (✳ idle) or punctuation (". " working, "* " idle) followed by the task
 * description. That task text frequently mentions other agents ("Compare Gemini
 * CLI vs Claude"), so the prefix — not the words — is Claude's identity signal.
 * Several detectors in `agent-detection` need this exact precedence check, and
 * keeping it in one place stops them from drifting (issue #5270).
 */

/** Claude Code's idle title prefix: ✳ (eight-spoked asterisk). */
export const CLAUDE_IDLE = '✳'

/** True when `title` begins with a Claude Code status prefix (✳ idle, ". "
 *  working, "* " idle), which identifies the session as Claude regardless of
 *  what the trailing task text mentions. */
export function hasClaudeStatusPrefix(title: string): boolean {
  // Why: Claude Code's own title-prefix identity signals (✳ idle, ". " working,
  // "* " idle) must win over agent-name tokens that only appear in task text.
  return (
    title.startsWith(`${CLAUDE_IDLE} `) ||
    title === CLAUDE_IDLE ||
    title.startsWith('. ') ||
    title.startsWith('* ')
  )
}
