/** Keep caller prompts for this session so failed launch panes can offer Copy; persisted outcomes survive restart without the text. */

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

export function forgetAgentLaunchPanePrompt(tabId: string): void {
  promptsByTabId.delete(tabId)
}
