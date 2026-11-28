import {
  MOBILE_PUSH_PROMPT_CATEGORY,
  MOBILE_PUSH_PROMPT_ROLES,
  type MobilePushPrompt,
  type MobilePushPromptOption
} from './notifications/mobile-push-contract'

/** Gateway `/v1/send` rejects a notification JSON larger than this. */
export const MOBILE_PUSH_NOTIFICATION_MAX_BYTES = 3000

const MAX_PROMPT_ID = 512
const MAX_OPTION_ID = 256
const MAX_LABEL = 80
const MAX_OPTIONS = 12

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function clipLabel(label: string): string {
  const normalized = label.replace(/\s+/g, ' ').trim()
  return normalized.length <= MAX_LABEL ? normalized : `${normalized.slice(0, MAX_LABEL - 1)}…`
}

/** Drop a prompt the gateway schema would reject. Labels are shortened; ids are not rewritten. */
function fitPushPrompt(prompt: MobilePushPrompt): MobilePushPrompt | null {
  if (prompt.promptId.length < 1 || prompt.promptId.length > MAX_PROMPT_ID) {
    return null
  }
  if (prompt.options.length < 1 || prompt.options.length > MAX_OPTIONS) {
    return null
  }
  const options: MobilePushPromptOption[] = []
  for (const option of prompt.options) {
    if (option.optionId.length < 1 || option.optionId.length > MAX_OPTION_ID) {
      return null
    }
    if (!MOBILE_PUSH_PROMPT_ROLES.includes(option.role)) {
      return null
    }
    const label = clipLabel(option.label)
    if (!label) {
      continue
    }
    options.push({ optionId: option.optionId, label, role: option.role })
  }
  return options.length > 0 ? { promptId: prompt.promptId, options } : null
}

/**
 * Needs-input alerts gain `category` and, when it fits, `prompt`.
 * A disabled gate returns the notification unchanged so a current gateway still accepts it.
 */
export function attachMobilePushPrompt<T extends object>(
  notification: T,
  prompt: MobilePushPrompt | null,
  enabled: boolean
): T & { category?: typeof MOBILE_PUSH_PROMPT_CATEGORY; prompt?: MobilePushPrompt } {
  if (!enabled) {
    return notification
  }
  const withCategory = { ...notification, category: MOBILE_PUSH_PROMPT_CATEGORY }
  if (jsonBytes(withCategory) > MOBILE_PUSH_NOTIFICATION_MAX_BYTES) {
    return notification
  }
  const fitted = prompt ? fitPushPrompt(prompt) : null
  if (!fitted) {
    return withCategory
  }
  const withPrompt = { ...withCategory, prompt: fitted }
  return jsonBytes(withPrompt) <= MOBILE_PUSH_NOTIFICATION_MAX_BYTES ? withPrompt : withCategory
}
