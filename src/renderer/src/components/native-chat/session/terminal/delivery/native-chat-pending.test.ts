import { expect, it } from 'vitest'
import { launchPromptAsMessage, shouldPruneLaunchPrompt } from './native-chat-pending'
import type { NativeChatMessage } from '../../../../../../../shared/native-chat/native-chat-types'

it('reconciles a launch prompt containing literal source-note syntax', () => {
  const text = '[Image source file: "/repo/a.png"; attached viewing copy: "/temp/a.png"]'
  const entry = { tabId: 'tab', agent: 'claude' as const, text, createdAt: 100 }
  const messages: NativeChatMessage[] = [
    {
      id: 'user',
      role: 'user',
      blocks: [{ type: 'text', text }],
      timestamp: 120,
      source: 'transcript'
    },
    { id: 'reply', role: 'assistant', blocks: [], timestamp: 130, source: 'transcript' }
  ]
  expect(launchPromptAsMessage(entry, messages)).toBeNull()
  expect(shouldPruneLaunchPrompt(entry, messages)).toBe(true)
})
