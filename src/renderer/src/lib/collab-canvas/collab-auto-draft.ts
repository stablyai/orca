/**
 * Decide when a finished agent turn should auto-land as an agent-draft on the
 * open session board. Pure so tests can drive the edge without React/tldraw.
 */

export type CollabAutoDraftDecision =
  | { place: true; body: string; dedupeKey: string }
  | { place: false; reason: string }

/**
 * After Send, we arm until the next working→done with a real reply.
 * Unrelated coding turns while the board is open do not place drafts unless armed.
 */
export function decideCollabAutoDraft(args: {
  armed: boolean
  wasWorking: boolean
  state: string
  reply: string | null | undefined
  /** paneKey + reply prefix already placed this session */
  alreadyPlacedKeys: ReadonlySet<string>
  paneKey: string
}): CollabAutoDraftDecision {
  if (!args.armed) {
    return { place: false, reason: 'not-armed' }
  }
  if (!args.wasWorking || args.state !== 'done') {
    return { place: false, reason: 'not-working-to-done' }
  }
  const body = args.reply?.trim()
  if (!body) {
    return { place: false, reason: 'empty-reply' }
  }
  const dedupeKey = `${args.paneKey}:${body.slice(0, 160)}`
  if (args.alreadyPlacedKeys.has(dedupeKey)) {
    return { place: false, reason: 'already-placed' }
  }
  return { place: true, body, dedupeKey }
}
