// @vitest-environment happy-dom

import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderCard } from './NewWorkspaceComposerCard.test-fixture'

const storeMocks = vi.hoisted(() => ({
  closeModal: vi.fn(),
  openModal: vi.fn(),
  openSettingsPage: vi.fn(),
  openSettingsTarget: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        closeModal: storeMocks.closeModal,
        openModal: storeMocks.openModal,
        openSettingsPage: storeMocks.openSettingsPage,
        openSettingsTarget: storeMocks.openSettingsTarget,
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

vi.mock('@/components/new-workspace/SetProjectLocationDialog', () => ({
  SetProjectLocationDialog: ({
    option,
    projectName,
    onClose,
    onReady
  }: {
    option: { label: string } | null
    projectName: string
    onClose: () => void
    onReady: (setupId: string) => void
  }) =>
    option ? (
      <div
        data-testid="set-project-location-dialog"
        data-host={option.label}
        data-project={projectName}
      >
        <button type="button" onClick={onClose}>
          Close location
        </button>
        <button type="button" onClick={() => onReady('setup-remote')}>
          Complete location
        </button>
      </div>
    ) : null
}))

describe('NewWorkspaceComposerCard set location', () => {
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    storeMocks.closeModal.mockReset()
    storeMocks.openModal.mockReset()
    storeMocks.openSettingsPage.mockReset()
  })

  afterEach(() => {
    container?.remove()
    container = null
  })

  // Async because the dialog is a lazy chunk: the click mounts Suspense, the chunk resolves next tick.
  it('opens set-location over the composer without leaving the create dialog', async () => {
    const nestedOpenChanges: boolean[] = []
    container = await renderCard({
      onNestedDialogOpenChange: (open) => nestedOpenChanges.push(open)
    })

    act(() => {
      container?.querySelector<HTMLElement>('div[data-run-target-combobox-root="true"]')?.click()
    })
    const setLocation = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.includes('Set project location')
    )
    expect(setLocation).toBeTruthy()
    act(() => setLocation?.click())
    await act(async () => {})

    const dialog = document.body.querySelector('[data-testid="set-project-location-dialog"]')
    expect(dialog?.getAttribute('data-host')).toBe('Devbox')
    expect(dialog?.getAttribute('data-project')).toBe('Platform')
    expect(nestedOpenChanges).toEqual([true])
    expect(storeMocks.closeModal).not.toHaveBeenCalled()
    expect(storeMocks.openModal).not.toHaveBeenCalled()
    expect(storeMocks.openSettingsPage).not.toHaveBeenCalled()
  })

  // Async for the same reason: without the flush this only passes when an earlier
  // test in this file already resolved the shared lazy chunk.
  it('closes the nested dialog before publishing the ready run target', async () => {
    const nestedOpenChanges: boolean[] = []
    const setupChanges: string[] = []
    container = await renderCard({
      onNestedDialogOpenChange: (open) => nestedOpenChanges.push(open),
      onProjectHostSetupChange: (setupId) => setupChanges.push(setupId)
    })

    act(() => {
      container?.querySelector<HTMLElement>('div[data-run-target-combobox-root="true"]')?.click()
    })
    const setLocation = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.includes('Set project location')
    )
    act(() => setLocation?.click())
    await act(async () => {})
    const complete = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Complete location'
    )
    act(() => complete?.click())

    expect(nestedOpenChanges).toEqual([true, false])
    expect(setupChanges).toEqual(['setup-remote'])
    expect(document.body.querySelector('[data-testid="set-project-location-dialog"]')).toBeNull()
  })
})
