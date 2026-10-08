// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'

const { activate, tabs, forkedFrom, savedName } = vi.hoisted(() => {
  const tabs: { current: Partial<Tab>[] } = { current: [] }
  const forkedFrom: { current: string | null } = { current: null }
  const savedName: { current: string | null } = { current: null }
  return { activate: vi.fn(), tabs, forkedFrom, savedName }
})
vi.mock('@/runtime/structured-conversation-name', () => ({
  useStructuredChatTabConversationName: (tab: unknown) => (tab ? savedName.current : null)
}))
vi.mock('@/lib/structured-agent-session-tab-activation', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  activateStructuredAgentSessionById: activate
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ unifiedTabsByWorktree: { worktree: tabs.current } })
}))
vi.mock('./StructuredAgentSessionStatusBridge', () => ({
  useStructuredAgentSessionForkedFrom: () => forkedFrom.current
}))

import { NativeChatForkedFromLine } from './NativeChatForkedFromLine'

afterEach(() => {
  cleanup()
  activate.mockReset()
  savedName.current = null
})

function parentTab(overrides: Partial<Tab> = {}): Partial<Tab> {
  return {
    id: 'tab-parent',
    worktreeId: 'worktree',
    entityId: 'parent-session',
    contentType: 'agent-session',
    label: 'Rewrite the parser',
    customLabel: null,
    ...overrides
  }
}

function renderLine() {
  return render(
    <NativeChatForkedFromLine
      sessionId="child-session"
      target={{ kind: 'local' }}
      worktreeId="worktree"
    />
  )
}

describe('the forked-from line', () => {
  it('names the parent by the name its host saved, as its tab does', () => {
    forkedFrom.current = 'parent-session'
    tabs.current = [parentTab({ label: 'Claude Chat' })]
    savedName.current = 'Rewrite the parser'

    renderLine()

    expect(screen.getByRole('button', { name: 'Rewrite the parser' })).toBeInTheDocument()
  })

  it('names the parent by its tab title and opens it', () => {
    forkedFrom.current = 'parent-session'
    tabs.current = [parentTab({ customLabel: 'Parser rewrite' })]

    renderLine()
    fireEvent.click(screen.getByRole('button', { name: 'Parser rewrite' }))

    expect(screen.getByText('Forked from')).toBeInTheDocument()
    expect(activate).toHaveBeenCalledWith({ worktreeId: 'worktree', sessionId: 'parent-session' })
  })

  it('draws nothing for a chat that is not a fork', () => {
    forkedFrom.current = null
    tabs.current = [parentTab()]

    expect(renderLine().container).toBeEmptyDOMElement()
  })

  it('draws nothing once the parent has no tab to name it by or go to', () => {
    forkedFrom.current = 'parent-session'
    tabs.current = []

    expect(renderLine().container).toBeEmptyDOMElement()
  })
})
