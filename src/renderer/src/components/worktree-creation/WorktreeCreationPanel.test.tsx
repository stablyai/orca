// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WorktreeCreationPanel from './WorktreeCreationPanel'

const mocks = vi.hoisted(() => ({
  state: {
    pendingWorktreeCreations: {
      'create-1': {
        creationId: 'create-1',
        phase: 'creating',
        status: 'creating',
        indeterminate: false,
        loaderVisible: true,
        request: {
          repoId: 'repo-1',
          name: 'new-workspace',
          displayName: 'New workspace',
          setupDecision: 'skip',
          agent: null,
          pendingFirstAgentMessageRename: false,
          note: '',
          startupPlan: null,
          quickPrompt: '',
          quickTelemetry: null
        }
      }
    }
  }
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state)
}))

vi.mock('@/lib/worktree-creation-flow', () => ({
  retryBackgroundWorktreeCreation: vi.fn()
}))

const roots: Root[] = []

async function renderPanel(reserveCollapsedSidebarHeaderSpace: boolean): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)

  await act(async () => {
    root.render(
      <WorktreeCreationPanel
        creationId="create-1"
        reserveCollapsedSidebarHeaderSpace={reserveCollapsedSidebarHeaderSpace}
      />
    )
  })

  return container
}

describe('WorktreeCreationPanel', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    roots.splice(0).forEach((root) => {
      act(() => root.unmount())
    })
    document.body.replaceChildren()
  })

  it('keeps the faux creation tab visible', async () => {
    const container = await renderPanel(false)

    expect(container.textContent).toContain('New workspace')
    expect(container.textContent).toContain('Creating worktree…')
    const title = [...container.querySelectorAll('span')].find(
      (node) => node.textContent === 'New workspace'
    )
    expect(title?.closest('div')?.className).toContain('border-r')
  })

  it('reserves collapsed left-titlebar space before the faux tab', async () => {
    const container = await renderPanel(true)
    const title = [...container.querySelectorAll('span')].find(
      (node) => node.textContent === 'New workspace'
    )
    const spacer = title?.closest('div')?.previousElementSibling as HTMLElement | null

    expect(spacer?.style.width).toBe('var(--collapsed-sidebar-header-width)')
  })

  it('does not reserve left-titlebar space when the header is not floating', async () => {
    const container = await renderPanel(false)
    const title = [...container.querySelectorAll('span')].find(
      (node) => node.textContent === 'New workspace'
    )

    expect(title?.closest('div')?.previousElementSibling).toBeNull()
  })
})
