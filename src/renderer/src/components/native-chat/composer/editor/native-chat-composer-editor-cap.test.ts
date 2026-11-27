import { expect, it, vi } from 'vitest'
import { keepNativeChatComposerEditors } from './native-chat-composer-editor-owner'

it('kept composer editors stay bounded even when every one holds a draft', () => {
  const kept = Array.from({ length: 17 }, () => ({
    destroyAll: vi.fn(),
    holdsNoText: () => false
  }))
  kept.forEach((editors, index) => keepNativeChatComposerEditors(`draft-tab-${index}`, editors))
  expect(kept[0]!.destroyAll).toHaveBeenCalledTimes(1)
  expect(kept.slice(1).every((editors) => editors.destroyAll.mock.calls.length === 0)).toBe(true)
})
