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
  error: {
    title: 'Could not load conversation',
    subtitle: 'The transcript could not be read. Toggle back to the terminal to keep working.'
  },
  notAgent: {
    title: 'No conversation here',
    subtitle: 'This terminal is not running a recognized coding agent.'
  }
} as const satisfies Record<string, NativeChatEmptyStateCopy>
