/** Classify the nested intent without accepting any outer terminal input fields. */
export function isTerminalChatPromptCall(method: string, params: unknown): boolean {
  return (
    method === 'terminal.send' &&
    params !== null &&
    typeof params === 'object' &&
    'chatPrompt' in params &&
    params.chatPrompt !== null &&
    typeof params.chatPrompt === 'object'
  )
}
