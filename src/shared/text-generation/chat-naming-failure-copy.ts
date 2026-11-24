// One English table for Orca-authored chat auto-name failures: main builds the wire `message`, the renderer translates by code.
export const CHAT_NAMING_FAILURE_COPY = {
  noName: 'The chat-name agent returned no name.',
  agentNotRun: 'Orca could not run the chat-name agent.',
  noAgentAvailable: 'No chat-name agent can run in this workspace.',
  grokFailed: 'Grok could not name this chat. Try generating the name again.',
  antigravityFailed: 'Antigravity could not name this chat. Try generating the name again.'
} as const

export type ChatNamingFailureCode = keyof typeof CHAT_NAMING_FAILURE_COPY

export function chatNamingFailure(code: ChatNamingFailureCode): {
  error: string
  errorCode: ChatNamingFailureCode
} {
  return { error: CHAT_NAMING_FAILURE_COPY[code], errorCode: code }
}
