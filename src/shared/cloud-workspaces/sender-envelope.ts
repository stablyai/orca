// Sender lines in older transcripts. While team sharing existed, messages sent to agents in a shared
// cloud workspace started with one machine-readable line naming the teammate who sent them:
//   [orca-sender name="…" id="…"]
// Nothing writes it any more, but transcripts from then still carry it, so chat rows strip it
// instead of showing the raw line.

// Older builds also wrote an email attribute; it is still matched so it strips.
const LINE =
  /^\[orca-sender name="((?:[^"\\]|\\.)*)" id="([A-Za-z0-9_.:-]{1,128})"(?: email="(?:[^"\\]|\\.)*")?\]\n/

/** Removes all stacked leading sender lines; text without one comes back unchanged. */
export function stripSenderEnvelopes(text: string): string {
  let body = text
  for (let match = LINE.exec(body); match; match = LINE.exec(body)) {
    body = body.slice(match[0].length)
  }
  return body
}
