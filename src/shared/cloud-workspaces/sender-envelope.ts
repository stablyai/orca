// Sender metadata for messages sent to agents in a shared cloud workspace. Several org members can
// drive the same agent, so each message carries one leading line naming who sent it, plus the
// member id the VM's `orca-git-as` takes, so the agent can commit and push as that person.
// The line is stable and machine-readable so UIs can render it as an attribution chip and strip it.

// No email: the line is visible to every teammate's agent and stored in transcripts.
export type MessageSender = { userId: string; name: string }

const PREFIX = '[orca-sender '
// Older builds also wrote an email attribute; it is still parsed (so it strips) but never kept.
const LINE =
  /^\[orca-sender name="((?:[^"\\]|\\.)*)" id="([A-Za-z0-9_.:-]{1,128})"(?: email="(?:[^"\\]|\\.)*")?\]\n/

function quote(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/["\\]/g, (c) => `\\${c}`)
    .slice(0, 120)
}

/**
 * Every leading envelope already in the text is dropped and replaced with the real sender's, so a
 * member cannot type `[orca-sender …]` lines to impersonate a teammate (re-wrapping is idempotent).
 */
export function withSenderEnvelope(text: string, sender: MessageSender): string {
  const body = stripSenderEnvelopes(text)
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(sender.userId)) {
    return body
  }
  return `${PREFIX}name="${quote(sender.name)}" id="${sender.userId}"]\n${body}`
}

/** Removes all stacked leading envelope lines. */
function stripSenderEnvelopes(text: string): string {
  let body = text
  for (let match = LINE.exec(body); match; match = LINE.exec(body)) {
    body = body.slice(match[0].length)
  }
  return body
}

/** The first envelope names the sender; any stacked ones under it are stripped from the body. */
export function parseSenderEnvelope(text: string): { sender: MessageSender | null; body: string } {
  const match = LINE.exec(text)
  if (!match) {
    return { sender: null, body: text }
  }
  return {
    sender: { name: match[1]!.replace(/\\(.)/g, '$1'), userId: match[2]! },
    body: stripSenderEnvelopes(text)
  }
}

/** One-time instruction for agents in shared workspaces (appended to org PR instructions). */
export const SENDER_AGENT_INSTRUCTIONS =
  'Messages in this shared workspace start with an [orca-sender name="…" id="…"] line naming the teammate who sent them. ' +
  'Address that person, and when you commit or push for them run git through `orca-git-as <id> <git args>` ' +
  '(for example `orca-git-as <id> push origin HEAD`) so the work is attributed to them.'
