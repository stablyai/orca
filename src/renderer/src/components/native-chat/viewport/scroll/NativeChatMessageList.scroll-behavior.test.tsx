// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// Why: these fixtures have neither inline visual owners nor sender navigation.
const unusedChatLeaves = vi.hoisted(() => ({
  inlineVisual: vi.fn(() => {
    throw new Error('Unexpected inline visual in transcript fixture')
  }),
  openSender: vi.fn(() => {
    throw new Error('Unexpected sender navigation in transcript fixture')
  })
}))
vi.mock('../../media/visuals/NativeChatInlineVisual', () => ({
  NativeChatInlineVisual: unusedChatLeaves.inlineVisual
}))
vi.mock('@/lib/open-agent-message-sender', () => ({
  openAgentMessageSender: unusedChatLeaves.openSender
}))
// Pacing is not this test's subject.
vi.mock('../../markdown/use-native-chat-paced-text', async (importOriginal) =>
  (await import('../../markdown/native-chat-unpaced-text-fixture')).unpacedTextModule(
    importOriginal
  )
)

afterEach(cleanup)

await import('../virtualization/NativeChatMessageList.growth-windowing.spec')
await import('../navigation/NativeChatMessageList.reader-navigation.spec')
