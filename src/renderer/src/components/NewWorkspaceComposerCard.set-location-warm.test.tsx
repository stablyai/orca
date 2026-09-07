// @vitest-environment happy-dom

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hostOptions, renderCard } from './NewWorkspaceComposerCard.test-fixture'
import type { ProjectHostSetupOption } from '@/lib/project-host-setup-options'

// Counts evaluations of the set-location chunk. A dynamic import evaluates a module once,
// so this only moves when the composer actually reaches for the chunk.
const chunk = vi.hoisted(() => ({ loads: 0 }))

// Renders a marker unconditionally so the "warming did not mount it" assertion below can
// actually fail; a `() => null` stub would make that check vacuous.
vi.mock('@/components/new-workspace/SetProjectLocationDialog', () => {
  chunk.loads += 1
  return {
    SetProjectLocationDialog: () => <div data-testid="set-project-location-dialog" />
  }
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        closeModal: vi.fn(),
        openModal: vi.fn(),
        openSettingsPage: vi.fn(),
        openSettingsTarget: vi.fn(),
        setRuntimeEnvironmentStatus: vi.fn(),
        setupProjectExistingFolder: vi.fn(),
        setupProjectClone: vi.fn(),
        activeModal: 'new-workspace-composer',
        settings: { defaultTuiAgent: null, disabledTuiAgents: [] },
        updateSettings: vi.fn(),
        projects: [],
        repos: []
      }),
    { getState: () => ({}) }
  )
}))

vi.mock('@/components/contextual-tours/use-contextual-tour', () => ({
  useContextualTour: vi.fn()
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/components/agent/AgentCombobox', () => ({
  default: () => <button type="button">Agent picker</button>
}))

vi.mock('@/components/sidebar/AddRemoteHostDialog', () => ({
  AddRemoteHostDialog: () => null
}))

vi.mock('@/components/sparse/SparseCheckoutPresetSelect', () => ({
  default: () => null
}))

vi.mock('@/components/new-workspace/SmartWorkspaceNameField', () => ({
  default: () => <input aria-label="workspace name" />
}))

vi.mock('@/components/new-workspace/ProjectCombobox', () => ({
  default: () => <div data-testid="project-combobox" />
}))

const readyOnlyHostOptions = hostOptions.filter((option) => option.kind === 'ready')
// A disconnected host is a needs-setup row with no "Set location" action, so it must not warm.
const unavailableHostOptions: ProjectHostSetupOption[] = [
  ...readyOnlyHostOptions,
  {
    kind: 'needs-setup',
    id: 'needs-setup:ssh:offline',
    projectId: 'project-group:platform',
    hostId: 'ssh:offline',
    label: 'Offline box',
    detail: 'Not connected',
    isAvailable: false,
    attention: false,
    canSetLocation: false
  }
]

// Declaration order matters here and nowhere else: a module evaluates once, so the
// no-warm cases have to observe the counter before anything warms it.
describe('NewWorkspaceComposerCard set-location chunk warm', () => {
  let container: HTMLDivElement | null = null

  afterEach(() => {
    container?.remove()
    container = null
  })

  it('does not warm the chunk when no host needs its location set', async () => {
    container = await renderCard({ projectHostSetupOptions: readyOnlyHostOptions })

    expect(
      [...container.querySelectorAll('button')].some((button) =>
        button.textContent?.includes('Set project location')
      )
    ).toBe(false)
    expect(chunk.loads).toBe(0)
  })

  it('does not warm the chunk when the needs-setup host cannot take a location', async () => {
    container = await renderCard({ projectHostSetupOptions: unavailableHostOptions })

    expect(chunk.loads).toBe(0)
  })

  it('warms the chunk on mount for a needs-setup host, before Set project location is clicked', async () => {
    container = await renderCard()

    expect(chunk.loads).toBe(1)
    // Warming must not mount the dialog; it still waits on an explicit click.
    expect(document.body.querySelector('[data-testid="set-project-location-dialog"]')).toBeNull()
  })
})
