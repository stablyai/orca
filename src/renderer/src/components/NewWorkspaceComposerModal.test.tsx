// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalAgentCatalogSnapshot } from '../../../shared/agent-catalog-snapshot'
import type { CustomTuiAgentId, TuiAgent } from '../../../shared/types'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const CUSTOM_CODEX = 'custom-agent:codex:22222222-2222-4222-8222-222222222222' as CustomTuiAgentId

const mocks = vi.hoisted(() => ({
  submitQuick: vi.fn(),
  createDisabled: false,
  catalog: {
    snapshot: null as unknown,
    loading: true,
    unavailable: false
  },
  cardProps: [] as { createDisabled?: boolean; onCreate?: () => void }[]
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      activeModal: 'new-workspace-composer',
      modalData: {},
      closeModal: vi.fn(),
      settings: { defaultTuiAgent: CUSTOM_CODEX, disabledTuiAgents: [] }
    })
}))

vi.mock('@/hooks/useComposerState', () => ({
  useComposerState: () => ({
    cardProps: {
      detectedAgentIds: new Set<TuiAgent>(['codex']),
      projectOptions: [],
      selectedProjectId: null,
      selectedRepoIsGit: true
    },
    composerRef: { current: null },
    onComposerNodeChange: vi.fn(),
    nameInputRef: { current: null },
    submitQuick: mocks.submitQuick,
    createDisabled: mocks.createDisabled,
    selectAddedProjectRepo: vi.fn()
  })
}))

vi.mock('@/hooks/useLocalAgentCatalog', () => ({
  useLocalAgentCatalog: () => ({
    snapshot: mocks.catalog.snapshot,
    loading: mocks.catalog.loading,
    unavailable: mocks.catalog.unavailable,
    refetch: vi.fn(),
    applySnapshot: vi.fn()
  })
}))

vi.mock('@/components/NewWorkspaceComposerCard', () => ({
  default: (props: { createDisabled?: boolean; onCreate?: () => void }) => {
    mocks.cardProps.push(props)
    return (
      <button
        type="button"
        data-testid="create"
        disabled={props.createDisabled}
        onClick={props.onCreate}
      >
        create
      </button>
    )
  }
}))

vi.mock('@/components/agent/AgentSettingsDialog', () => ({ default: () => null }))

vi.mock('@/lib/lazy-with-retry', () => ({ lazyWithRetry: () => () => null }))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h1>{children}</h1>
}))

const READY_CUSTOM_CATALOG = {
  customAgents: [
    {
      status: 'ready',
      definition: {
        id: CUSTOM_CODEX,
        baseAgent: 'codex',
        label: 'Team Codex',
        args: '--model team',
        syncEnv: false,
        commandOverride: '/opt/bin/codex'
      },
      envSummary: { entryCount: 0, bytes: 0 },
      availabilityReason: 'configured-executable'
    }
  ]
} as unknown as LocalAgentCatalogSnapshot

let container: HTMLDivElement
let root: Root

async function render(): Promise<void> {
  const { default: NewWorkspaceComposerModal } = await import('./NewWorkspaceComposerModal')
  await act(async () => {
    root.render(<NewWorkspaceComposerModal />)
  })
}

function clickCreate(): void {
  const button = container.querySelector<HTMLButtonElement>('[data-testid="create"]')
  expect(button).not.toBeNull()
  act(() => {
    button?.click()
  })
}

beforeEach(() => {
  mocks.submitQuick.mockReset()
  mocks.createDisabled = false
  mocks.catalog.snapshot = null
  mocks.catalog.loading = true
  mocks.catalog.unavailable = false
  mocks.cardProps = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('NewWorkspaceComposerModal quick create', () => {
  it('blocks create while the local agent catalog is still loading', async () => {
    await render()

    expect(mocks.cardProps.at(-1)?.createDisabled).toBe(true)
    clickCreate()
    expect(mocks.submitQuick).not.toHaveBeenCalled()
  })

  it('submits the custom default once the catalog has loaded', async () => {
    mocks.catalog.snapshot = READY_CUSTOM_CATALOG
    mocks.catalog.loading = false
    await render()

    expect(mocks.cardProps.at(-1)?.createDisabled).toBe(false)
    clickCreate()
    expect(mocks.submitQuick).toHaveBeenCalledWith(CUSTOM_CODEX)
  })

  it('still allows create where the local catalog surface does not exist', async () => {
    mocks.catalog.loading = false
    mocks.catalog.unavailable = true
    await render()

    expect(mocks.cardProps.at(-1)?.createDisabled).toBe(false)
    clickCreate()
    expect(mocks.submitQuick).toHaveBeenCalledWith('codex')
  })

  it('keeps the composer create gate disabled independently of the catalog', async () => {
    mocks.createDisabled = true
    mocks.catalog.snapshot = READY_CUSTOM_CATALOG
    mocks.catalog.loading = false
    await render()

    expect(mocks.cardProps.at(-1)?.createDisabled).toBe(true)
  })
})
