/**
 * The prompt of a launch whose tab this window showed, so its pane can offer to copy it if the
 * agent did not start. Held for this session only: the prompt is the caller's, and after a restart
 * the pane still says what happened, without the copy.
 */

const MAX_REMEMBERED_PROMPTS = 32
const promptsByTabId = new Map<string, string>()

export function rememberAgentLaunchPanePrompt(tabId: string, prompt: string): void {
  promptsByTabId.delete(tabId)
  promptsByTabId.set(tabId, prompt)
  for (const oldest of promptsByTabId.keys()) {
    if (promptsByTabId.size <= MAX_REMEMBERED_PROMPTS) {
      break
    }
    promptsByTabId.delete(oldest)
  }
}

export function agentLaunchPanePrompt(tabId: string): string | null {
  return promptsByTabId.get(tabId) ?? null
}

/** The pane's launch settled or went away: nothing is left to offer. */
export function forgetAgentLaunchPanePrompt(tabId: string): void {
  promptsByTabId.delete(tabId)
}
