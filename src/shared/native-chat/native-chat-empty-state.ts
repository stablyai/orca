// Shared English fallback copy for desktop i18n/mobile. Callers substitute {{value0}} with the agent label.

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
  /** A chat whose conversation the host has not found: new, or not reported by the agent. */
  notFound: {
    title: "Can't find this conversation yet",
    subtitle:
      'Send a message to start one, or open the terminal view to see what {{value0}} is doing.'
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

/** Substitute the agent label on platforms without i18n (mobile). */
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
