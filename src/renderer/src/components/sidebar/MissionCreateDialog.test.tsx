// @vitest-environment happy-dom
import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MissionCreateResult } from '../../../../shared/types'

const mocks = vi.hoisted(() => ({
  createMission: vi.fn<(args: unknown) => Promise<MissionCreateResult | null>>(),
  closeModal: vi.fn(),
  setSidebarListMode: vi.fn(),
  repos: [] as { id: string; displayName: string; projectGroupId?: string }[],
  projectGroups: [] as { id: string; name: string; parentGroupId: string | null }[],
  comboboxProps: [] as { groups?: readonly unknown[] }[]
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      activeModal: 'mission-create',
      closeModal: mocks.closeModal,
      repos: mocks.repos,
      projectGroups: mocks.projectGroups,
      createMission: mocks.createMission,
      setSidebarListMode: mocks.setSidebarListMode,
      settings: null,
      detectedAgentIds: null
    })
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

// Why: repo selection lives behind a Radix popover + cmdk stack; the dialog
// only consumes its onChange, so the test drives selection through a stub
// and records the props the dialog hands to the picker.
vi.mock('@/components/ui/repo-multi-combobox', () => ({
  default: (props: {
    onChange: (next: ReadonlySet<string>) => void
    groups?: readonly unknown[]
  }) => {
    mocks.comboboxProps.push(props)
    return (
      <button
        type="button"
        data-testid="select-repo"
        onClick={() => props.onChange(new Set(['r1']))}
      >
        select repo
      </button>
    )
  }
}))

vi.mock('@/components/agent/AgentCombobox', () => ({
  default: () => null
}))

import MissionCreateDialog from './MissionCreateDialog'

let root: Root | null = null

function renderDialog(): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(<MissionCreateDialog />)
  })
  return container
}

function setNativeValue(input: HTMLInputElement, text: string): void {
  // Why: React reads controlled-input changes via the native value setter;
  // assigning input.value directly is swallowed by React's value tracking.
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setValue?.call(input, text)
}

const CREATE_FAILURE_COPY = 'Could not create the mission. Try again.'

describe('MissionCreateDialog', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    mocks.createMission.mockReset()
    mocks.closeModal.mockReset()
    mocks.setSidebarListMode.mockReset()
    mocks.repos = [{ id: 'r1', displayName: 'Dashboard' }]
    mocks.projectGroups = []
    mocks.comboboxProps = []
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
      root = null
    }
    document.body.replaceChildren()
  })

  it('surfaces an error and keeps the dialog open when creation resolves null', async () => {
    mocks.createMission.mockResolvedValue(null)
    const rendered = renderDialog()

    act(() => {
      rendered.querySelector<HTMLButtonElement>('[data-testid="select-repo"]')?.click()
    })
    act(() => {
      const nameInput = rendered.querySelector('input')
      expect(nameInput).not.toBeNull()
      setNativeValue(nameInput!, 'Referral')
      nameInput!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(rendered.textContent).not.toContain(CREATE_FAILURE_COPY)

    await act(async () => {
      const form = rendered.querySelector('form')
      expect(form).not.toBeNull()
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(mocks.createMission).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Referral',
        branchName: 'mission/referral',
        repoIds: ['r1']
      })
    )
    expect(rendered.textContent).toContain(CREATE_FAILURE_COPY)
    // The form stays editable for a retry — neither closed nor switched to
    // the member status list.
    expect(mocks.closeModal).not.toHaveBeenCalled()
    expect(rendered.textContent).toContain('Create Mission')
  })

  it('hands eligible group bulk-select options to the project picker', () => {
    mocks.projectGroups = [
      { id: 'g1', name: 'Platform', parentGroupId: null },
      { id: 'g2', name: 'Nested', parentGroupId: 'g1' }
    ]
    mocks.repos = [
      { id: 'r1', displayName: 'Dashboard', projectGroupId: 'g1' },
      { id: 'r2', displayName: 'Docs', projectGroupId: 'g2' },
      { id: 'r3', displayName: 'Loose' }
    ]
    renderDialog()

    const { groups } = mocks.comboboxProps.at(-1) ?? {}
    // Subtree semantics: the parent group bundles its nested group's repos.
    expect(groups).toEqual([
      { id: 'g1', name: 'Platform', repoIds: ['r1', 'r2'] },
      { id: 'g2', name: 'Nested', repoIds: ['r2'] }
    ])
  })
})
