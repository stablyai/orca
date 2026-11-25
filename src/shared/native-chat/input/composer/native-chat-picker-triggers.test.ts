import { expect, it } from 'vitest'
import type { NativeChatPickerItem } from './native-chat-picker-items'
import { applyPickerSuggestion } from './native-chat-picker-triggers'

const skill: NativeChatPickerItem = {
  kind: 'skill',
  id: 'batch-orchestrate',
  name: 'batch-orchestrate',
  token: '/batch-orchestrate',
  description: null,
  sources: []
}

it('replaces the whole token when the caret sits inside it', () => {
  expect(applyPickerSuggestion('/batch-orchestrate the rest', 9, skill)).toEqual({
    draft: '/batch-orchestrate the rest',
    caret: 19,
    insertedToken: '/batch-orchestrate',
    replacedEnd: 19
  })
})
