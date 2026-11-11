// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectHostSetupOption } from '@/lib/project-host-setup-options'
import { TooltipProvider } from '@/components/ui/tooltip'
import RunTargetCombobox from './RunTargetCombobox'
import { useAppStore } from '@/store/index'
import { resetOrcaCloudBillingCache } from './orca-cloud-billing-cache'
import type { EphemeralVmRecipeOption } from './run-target-options'
import type { OrcaCloudRunTargetAccess } from './orca-cloud-run-target-access'

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverAnchor: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))
vi.mock('@/components/billing/plans/plans-page-store', () => ({ openPlansPage: vi.fn() }))

const hosts: ProjectHostSetupOption[] = [
  {
    id: 'mac',
    kind: 'ready',
    projectId: 'p',
    hostId: 'local',
    repoId: 'mac',
    label: 'Local Mac',
    detail: 'desktop-app',
    path: '/tmp/desktop-app'
  }
]
const cloud: EphemeralVmRecipeOption = {
  id: 'cloud',
  name: 'Orca Cloud',
  provider: 'orca-cloud',
  create: 'orca-cloud create'
}

let container: HTMLDivElement
let root: Root
const openSettingsTarget = vi.fn()

function input(): HTMLInputElement {
  const node = container.querySelector<HTMLInputElement>('[role="combobox"]')
  if (!node) {
    throw new Error('run target input not found')
  }
  return node
}

function press(key: string): void {
  act(() => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

/** The composer's picker: Orca Cloud picks go through onSelectOrcaCloud (setup after Start). */
function renderComposer(access: OrcaCloudRunTargetAccess, onSelectOrcaCloud = vi.fn()): void {
  act(() => {
    root.render(
      <TooltipProvider>
        <RunTargetCombobox
          hostOptions={hosts}
          hostValue="mac"
          hostExecutionHostId="local"
          recipes={[cloud]}
          orcaCloudAvailability="offered"
          recipeValue={null}
          onRecipeChange={() => {}}
          onAddSshHost={() => {}}
          onAddRemoteServer={() => {}}
          orcaCloudAccess={access}
          onSelectOrcaCloud={onSelectOrcaCloud}
        />
      </TooltipProvider>
    )
  })
  act(() => {
    input().focus()
    input().click()
  })
}

function cloudRow(): HTMLElement | null {
  return (
    [...container.querySelectorAll<HTMLElement>('[role="option"]')].find((row) =>
      row.textContent?.startsWith('Orca Cloud')
    ) ?? null
  )
}

const outOfHours: OrcaCloudRunTargetAccess = {
  state: 'out-of-hours',
  cause: 'hours',
  canManageBilling: true
}

beforeEach(() => {
  resetOrcaCloudBillingCache()
  openSettingsTarget.mockClear()
  useAppStore.setState({ openSettingsTarget })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  localStorage.removeItem('orca:dev:runOnPreflight')
})

describe('Run on preflight (JA-21, flagged)', () => {
  it('flag off: nothing changes, the composer picks Orca Cloud and setup comes after Start', () => {
    const onSelectOrcaCloud = vi.fn()
    renderComposer(outOfHours, onSelectOrcaCloud)
    expect(cloudRow()?.getAttribute('aria-disabled')).toBeNull()
    expect(container.textContent).not.toContain('Turn on overage')
    press('ArrowDown')
    press('Enter')
    expect(onSelectOrcaCloud).toHaveBeenCalledOnce()
  })

  it('flag on: a billing wall disables the row with its reason and one fix, and Enter runs the fix', () => {
    localStorage.setItem('orca:dev:runOnPreflight', '1')
    const onSelectOrcaCloud = vi.fn()
    renderComposer(outOfHours, onSelectOrcaCloud)
    expect(cloudRow()?.getAttribute('aria-disabled')).toBe('true')
    expect(cloudRow()?.textContent).toContain('Out of sandbox hours')
    expect(cloudRow()?.textContent).toContain('Turn on overage')
    press('ArrowDown')
    press('Enter')
    expect(onSelectOrcaCloud).not.toHaveBeenCalled()
    expect(openSettingsTarget).toHaveBeenCalledWith(
      expect.objectContaining({ pane: 'cloud-billing' })
    )
  })

  it('flag on: a plan not started yet is setup, not a wall, so it stays pickable', () => {
    localStorage.setItem('orca:dev:runOnPreflight', '1')
    const onSelectOrcaCloud = vi.fn()
    renderComposer({ state: 'no-plan', lapsed: false, canManageBilling: true }, onSelectOrcaCloud)
    expect(cloudRow()?.getAttribute('aria-disabled')).toBeNull()
    press('ArrowDown')
    press('Enter')
    expect(onSelectOrcaCloud).toHaveBeenCalledOnce()
  })
})
