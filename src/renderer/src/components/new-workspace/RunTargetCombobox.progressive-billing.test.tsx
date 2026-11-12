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
vi.mock('@/components/billing/plans/plans-page-store', () => ({
  openPlansPage: vi.fn()
}))

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

const blocked: [string, OrcaCloudRunTargetAccess][] = [
  ['owner out of hours', { state: 'out-of-hours', cause: 'hours', canManageBilling: true }],
  ['member out of hours', { state: 'out-of-hours', cause: 'hours', canManageBilling: false }],
  ['member at the spend cap', { state: 'out-of-hours', cause: 'cap', canManageBilling: false }],
  ['member, payment failed', { state: 'payment-issue', canManageBilling: false }],
  ['member, plan ended', { state: 'no-plan', lapsed: true, canManageBilling: false }]
]

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
})

describe('progressive billing in Run on (JA-21, Neil)', () => {
  it.each(blocked)(
    '%s: Orca Cloud stays pickable with no billing words, and Enter picks it',
    (_name, access) => {
      const onSelectOrcaCloud = vi.fn()
      renderComposer(access, onSelectOrcaCloud)
      expect(cloudRow()?.getAttribute('aria-disabled')).toBeNull()
      const text = cloudRow()?.textContent ?? ''
      for (const word of [
        'sandbox hours',
        'overage',
        'spend cap',
        'Payment',
        'plan ended',
        'Ask an owner'
      ]) {
        expect(text).not.toContain(word)
      }
      press('ArrowDown')
      press('Enter')
      expect(onSelectOrcaCloud).toHaveBeenCalledOnce()
      expect(openSettingsTarget).not.toHaveBeenCalled()
    }
  )
})
