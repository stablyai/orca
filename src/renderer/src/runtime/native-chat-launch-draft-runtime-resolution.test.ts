import { describe, expect, it, vi } from 'vitest'
import { applyNativeChatLaunchDraftResolved } from './native-chat-launch-draft-runtime-resolution'

describe('applyNativeChatLaunchDraftResolved', () => {
  it('routes the exact generation to the store action', () => {
    const resolveNativeChatLaunchDraft = vi.fn()

    applyNativeChatLaunchDraftResolved(
      { resolveNativeChatLaunchDraft },
      { type: 'nativeChatLaunchDraftResolved', tabId: 'tab-1', text: 'seed', createdAt: 7 }
    )

    expect(resolveNativeChatLaunchDraft).toHaveBeenCalledWith('tab-1', {
      text: 'seed',
      createdAt: 7
    })
  })
})
