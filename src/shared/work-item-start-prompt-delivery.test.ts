import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WORK_ITEM_START_PROMPT_DELIVERY,
  resolveWorkItemStartPromptDelivery
} from './work-item-start-prompt-delivery'

describe('resolveWorkItemStartPromptDelivery', () => {
  it('keeps draft as the compatibility default when the setting is absent', () => {
    expect(DEFAULT_WORK_ITEM_START_PROMPT_DELIVERY).toBe('draft')
    expect(resolveWorkItemStartPromptDelivery(undefined)).toBe('draft')
  })

  it('preserves an explicit draft preference', () => {
    expect(resolveWorkItemStartPromptDelivery('draft')).toBe('draft')
  })

  it('preserves an explicit submit-after-ready preference', () => {
    expect(resolveWorkItemStartPromptDelivery('submit-after-ready')).toBe('submit-after-ready')
  })
})
