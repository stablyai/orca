// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'

const { activate, tabs } = vi.hoisted(() => ({
  activate: vi.fn(),
  tabs: { current: [] as Partial<Tab>[] }
}))
vi.mock('@/lib/structured-agent-session-tab-activation', () => ({
  activateStructuredAgentSessionById: activate
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ unifiedTabsByWorktree: { worktree: tabs.current } })
}))

import { NativeChatForkedFromLine } from './NativeChatForkedFromLine'
import { structuredSessionForkState } from './structured-agent-session-fork-state'

afterEach(cleanup)

function parentTab(overrides: Partial<Tab> = {}): Partial<Tab> {
  return {
    id: 'tab-parent',
    entityId: 'parent-session',
    contentType: 'agent-session',
    label: 'Rewrite the parser',
    customLabel: null,
    ...overrides
  }
}

describe('forked-from lineage line', () => {
  it('renders the parent the CONTROLLER derived, not one handed straight to the prop', () => {
    // Closes the last hop of the lineage chain: wire field -> controller field -> this component.
    // Rendering with a literal prop proves the component, and nothing that feeds it.
    tabs.current = [parentTab()]
    const state = { items: [], fence: 1, cursor: { epoch: 'epoch' } } as unknown as Parameters<
      typeof structuredSessionForkState
    >[0]
    const derived = structuredSessionForkState(state, 'child-session', {
      sessionId: 'child-session',
      commands: [],
      forkSupported: true,
      forkedFromSessionId: 'parent-session'
    })
    render(
      <NativeChatForkedFromLine
        worktreeId="worktree"
        parentSessionId={derived.forkedFromSessionId}
      />
    )
    expect(screen.getByRole('button', { name: 'Rewrite the parser' })).toBeInTheDocument()
    // A host that predates the field sends nothing, and the line must simply not appear.
    cleanup()
    render(
      <NativeChatForkedFromLine
        worktreeId="worktree"
        parentSessionId={
          structuredSessionForkState(state, 'child-session', {
            sessionId: 'child-session',
            commands: [],
            forkSupported: true
          }).forkedFromSessionId
        }
      />
    )
    expect(screen.queryByText('Forked from')).not.toBeInTheDocument()
  })

  it('names the parent chat and opens its tab', () => {
    activate.mockReset()
    tabs.current = [parentTab()]
    render(<NativeChatForkedFromLine worktreeId="worktree" parentSessionId="parent-session" />)
    expect(screen.getByText('Forked from')).toBeInTheDocument()
    const link = screen.getByRole('button', { name: 'Rewrite the parser' })
    link.click()
    expect(activate).toHaveBeenCalledExactlyOnceWith({
      worktreeId: 'worktree',
      sessionId: 'parent-session'
    })
  })

  it('prefers the name the user gave the parent', () => {
    tabs.current = [parentTab({ customLabel: 'Parser work' })]
    render(<NativeChatForkedFromLine worktreeId="worktree" parentSessionId="parent-session" />)
    expect(screen.getByRole('button', { name: 'Parser work' })).toBeInTheDocument()
  })

  // A host that predates `forkedFrom` sends no field at all: absence is the whole degrade path.
  it('renders nothing when the host reported no fork source', () => {
    tabs.current = [parentTab()]
    const { container } = render(
      <NativeChatForkedFromLine worktreeId="worktree" parentSessionId={undefined} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing rather than a dead control when the parent tab is gone', () => {
    tabs.current = []
    const { container } = render(
      <NativeChatForkedFromLine worktreeId="worktree" parentSessionId="parent-session" />
    )
    expect(container).toBeEmptyDOMElement()
  })
})
