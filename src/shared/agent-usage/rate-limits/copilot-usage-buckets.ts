export const COPILOT_AIC_BUCKET_NAME = 'AIC'
export const COPILOT_CHAT_BUCKET_NAME = 'Chat'
export const COPILOT_COMPLETIONS_BUCKET_NAME = 'Completions'

export const COPILOT_USAGE_BUCKET_NAMES = [
  COPILOT_AIC_BUCKET_NAME,
  COPILOT_CHAT_BUCKET_NAME,
  COPILOT_COMPLETIONS_BUCKET_NAME
] as const

export function isCopilotUsageBucket(name: string): boolean {
  return COPILOT_USAGE_BUCKET_NAMES.some((bucket) => bucket === name)
}
