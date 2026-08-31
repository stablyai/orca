// Canonical English copy for the native-chat empty/loading/error states, shared
// by the desktop renderer (as its i18n fallback strings) and the mobile app
// (used directly — mobile ships English only) so the two surfaces never drift.
// `{{value0}}` is the agent label; each caller substitutes it (i18n on desktop,
// `formatNativeChatEmptyStateCopy` on mobile).

export type NativeChatEmptyStateCopy = { title: string; subtitle: string }

export const NATIVE_CHAT_EMPTY_STATE_COPY = {
  loading: {
    title: 'Loading conversation…',
    subtitle: 'Reading the agent transcript.'
  },
  empty: {
    title: 'Start a chat with {{value0}}',
    subtitle: 'Ask {{value0}} to inspect code, explain output, or make a change.'
  },
  // Distinct from `empty` on purpose: the pane has an agent but no conversation
  // address, so "start a chat" would claim the transcript is empty when Orca
  // simply cannot read it. Names the recovery the user actually has.
  waitingSession: {
    title: 'No conversation linked yet',
    subtitle:
      'Orca has not received a session id for this {{value0}} terminal. Switch to terminal view to keep working.'
  },
  // The session is addressable but its transcript file does not exist yet.
  awaitingTranscript: {
    title: 'Transcript not written yet',
    subtitle:
      '{{value0}} has not saved this conversation to disk. It appears here as soon as it does.'
  },
  // Loaded, genuinely empty, but the agent is mid-turn: inviting a first message
  // would contradict the working indicator sitting right below it.
  workingEmpty: {
    title: '{{value0}} is working',
    subtitle: 'This conversation has no messages yet. Turns appear here as they are written.'
  },
  error: {
    title: 'Could not load conversation',
    subtitle: 'The transcript could not be read. Toggle back to the terminal to keep working.'
  },
  notAgent: {
    title: 'No conversation here',
    subtitle: 'This terminal is not running a recognized coding agent.'
  }
} as const satisfies Record<string, NativeChatEmptyStateCopy>

/** Resolve the empty-state copy with the agent label substituted for `{{value0}}`.
 *  For platforms without an i18n layer (mobile). */
export function formatNativeChatEmptyStateCopy(
  kind: keyof typeof NATIVE_CHAT_EMPTY_STATE_COPY,
  agentLabel: string
): NativeChatEmptyStateCopy {
  const copy = NATIVE_CHAT_EMPTY_STATE_COPY[kind]
  return {
    title: copy.title.replaceAll('{{value0}}', agentLabel),
    subtitle: copy.subtitle.replaceAll('{{value0}}', agentLabel)
  }
}
