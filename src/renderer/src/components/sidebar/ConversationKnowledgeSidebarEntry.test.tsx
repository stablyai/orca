// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n/i18n'
import ConversationKnowledgeSidebarEntry from './ConversationKnowledgeSidebarEntry'

const mocks = vi.hoisted(() => ({
  open: false,
  setOpen: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (
    selector: (state: {
      conversationKnowledgeDrawerOpen: boolean
      setConversationKnowledgeDrawerOpen: (open: boolean) => void
    }) => unknown
  ) =>
    selector({
      conversationKnowledgeDrawerOpen: mocks.open,
      setConversationKnowledgeDrawerOpen: mocks.setOpen
    })
}))

let root: Root | null = null

describe('ConversationKnowledgeSidebarEntry localization', () => {
  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    await i18n.changeLanguage('en')
  })

  afterEach(async () => {
    act(() => root?.unmount())
    root = null
    document.body.replaceChildren()
    vi.clearAllMocks()
    await i18n.changeLanguage('en')
  })

  it('relabels itself when the UI language changes after mount', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root?.render(<ConversationKnowledgeSidebarEntry />))

    expect(container.textContent).toContain('Conversation Knowledge')

    await act(async () => {
      await i18n.changeLanguage('zh')
    })

    expect(container.textContent).toContain('会话知识')
  })
})
