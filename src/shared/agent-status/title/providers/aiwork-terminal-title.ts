// AiWork titles itself `AiWork` at start, `AiWork | <session>` at rest and `<spinner> AiWork | <session> — <activity>`
// while busy, with a leading `●` when it wants attention; the activity changes with every tool step, and only the
// session names the conversation.
const AIWORK_TITLE_RE = /^(?:● )?(?:[\u2800-\u28FF] )?AiWork(?: \| (.*?))?(?: — .*)?$/u

/** The session part of an AiWork title (leading spinner optional), or null for its bare identity. */
export function aiworkTitleConversationName(title: string): string | null {
  const match = AIWORK_TITLE_RE.exec(title.trim())
  if (!match) {
    return title
  }
  return match[1]?.trim() || null
}
