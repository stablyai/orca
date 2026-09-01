// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WorktreeCreationPanel from './WorktreeCreationPanel'
import type { PendingWorktreeCreation } from '@/lib/pending-worktree-creation'

const mocks = vi.hoisted(() => ({
  state: {
    pendingWorktreeCreations: {
      'create-1': {
        creationId: 'create-1',
        phase: 'creating',
        status: 'creating',
        startedAt: Date.now(),
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
    } as Record<string, PendingWorktreeCreation>
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
    mocks.state.pendingWorktreeCreations['create-1'] = {
      creationId: 'create-1',
      phase: 'creating',
      status: 'creating',
      startedAt: Date.now(),
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
        quickTelemetry: null
      }
    }
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

  it('shows provisioning logs while a VM recipe is running', async () => {
    mocks.state.pendingWorktreeCreations['create-1'] = {
      ...mocks.state.pendingWorktreeCreations['create-1'],
      phase: 'provisioning-vm',
      provisioningLog: 'creating sandbox\nstarting orca serve\n'
    }

    const container = await renderPanel(false)

    expect(container.textContent).toContain('Provisioning VM')
    expect(container.querySelector('pre')?.textContent).toBe(
      'creating sandbox\nstarting orca serve\n'
    )
    // Constant height so the log box never grows before the scroll kicks in.
    expect(container.querySelector('pre')?.className).toContain('h-72')
    // A visible Cancel control, not just the tiny tab X, since the hint says Cancel stops provisioning.
    const cancel = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Cancel'
    )
    expect(cancel).toBeTruthy()
  })

  it('surfaces the captured recipe output when a VM recipe fails', async () => {
    mocks.state.pendingWorktreeCreations['create-1'] = {
      ...mocks.state.pendingWorktreeCreations['create-1'],
      phase: 'provisioning-vm',
      status: 'error',
      error: 'Recipe exited with code 1.',
      provisioningLog: 'pulling image…\nERROR: no space left on device\n'
    }

    const container = await renderPanel(false)

    // The short status, the actionable log, and Retry/Dismiss are all present.
    expect(container.textContent).toContain('Couldn’t create worktree')
    expect(container.textContent).toContain('Recipe exited with code 1.')
    const log = container.querySelector('pre')
    expect(log?.textContent).toBe('pulling image…\nERROR: no space left on device\n')
    // Failure reuses the same centered provisioning layout (h-72 log) so nothing shifts.
    expect(log?.className).toContain('h-72')
    expect(container.textContent).toContain('Retry')
  })

  it('omits the recipe output panel for a non-VM creation failure', async () => {
    mocks.state.pendingWorktreeCreations['create-1'] = {
      ...mocks.state.pendingWorktreeCreations['create-1'],
      status: 'error',
      error: 'git worktree add failed'
    }

    const container = await renderPanel(false)

    expect(container.textContent).toContain('git worktree add failed')
    expect(container.querySelector('pre')).toBeNull()
  })
})
