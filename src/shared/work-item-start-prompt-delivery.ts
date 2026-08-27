export const DEFAULT_WORK_ITEM_START_PROMPT_DELIVERY = 'draft' as const

export type WorkItemStartPromptDelivery = 'draft' | 'submit-after-ready'

export function resolveWorkItemStartPromptDelivery(value: unknown): WorkItemStartPromptDelivery {
  return value === 'submit-after-ready' ? 'submit-after-ready' : 'draft'
}
