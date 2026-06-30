// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WorktreeCreationPanel from './WorktreeCreationPanel'

const mocks = vi.hoisted(() => {
  // Why: vi.hoisted infers the mock shape from the initial value, which would
  // omit the optional `error` field. Declare the entry shape once so test
  // helpers can reassign the entry without TS dropping the field.
  type MockEntry = {
    creationId: string
    phase: string
    status: 'creating' | 'error'
    indeterminate: boolean
    loaderVisible: boolean
    error?: string
    request: Record<string, unknown>
  }
  return {
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
        } satisfies MockEntry
      } as Record<string, MockEntry>
    }
  }
})

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

function setEntryToError(error: string | undefined): void {
  mocks.state.pendingWorktreeCreations['create-1'] = {
    creationId: 'create-1',
    phase: 'error',
    status: 'error',
    indeterminate: false,
    loaderVisible: false,
    error,
    request: {
      repoId: 'repo-1',
      name: 'foo',
      displayName: 'foo',
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

  it('falls back to the generic i18n string when entry.error is missing', async () => {
    setEntryToError(undefined)
    const container = await renderPanel(false)

    expect(container.textContent).toContain('Couldn’t create worktree')
    expect(container.textContent).toContain('Something went wrong while creating the worktree.')
  })

  it('renders the raw error string when the [code] prefix is unparseable', async () => {
    setEntryToError('plain message without [code] prefix')
    const container = await renderPanel(false)

    expect(container.textContent).toContain('Couldn’t create worktree')
    expect(container.textContent).toContain('plain message without [code] prefix')
  })

  it('resolves a dedicated i18n key when the error carries a known [code] prefix', async () => {
    setEntryToError('[network] Could not refresh base ref "main" from "origin".')
    const container = await renderPanel(false)

    expect(container.textContent).toContain('Couldn’t create worktree')
    expect(container.textContent).toContain('Network error. Check your connection and try again.')
  })

  it.each([
    ['[auth] Could not refresh base ref "main" from "origin".', 'Remote authentication failed'],
    ['[noUpstream] Could not refresh base ref "main" from "origin".', 'no upstream'],
    [
      '[remoteRefMissing] Could not refresh base ref "main" from "origin".',
      'does not exist on the remote'
    ],
    [
      '[remoteForbidden] Could not refresh base ref "main" from "origin".',
      'inaccessible or forbidden'
    ]
  ])('resolves the dedicated i18n key for prefix %s', async (rawError, expectedFragment) => {
    setEntryToError(rawError)
    const container = await renderPanel(false)

    expect(container.textContent).toContain('Couldn’t create worktree')
    expect(container.textContent).toContain(expectedFragment)
  })

  it('interpolates the friendly prefix into the unknown template', async () => {
    setEntryToError('[unknown] Could not refresh base ref "main" from "origin".')
    const container = await renderPanel(false)

    expect(container.textContent).toContain('Couldn’t create worktree')
    expect(container.textContent).toContain('Could not refresh base ref "main" from "origin".')
  })
})
