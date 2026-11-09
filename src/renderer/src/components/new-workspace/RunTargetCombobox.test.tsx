// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { ProjectHostSetupOption } from '@/lib/project-host-setup-options'
import { TooltipProvider } from '@/components/ui/tooltip'
import RunTargetCombobox from './RunTargetCombobox'
import { useAppStore } from '@/store/index'
import { resetOrcaCloudBillingCache } from './orca-cloud-billing-cache'
import type { OrcaCloudAvailability } from '../../../../shared/orca-yaml-hook-types'
import type { EphemeralVmRecipeOption } from './run-target-options'
import type { OrcaCloudRunTargetAccess } from './orca-cloud-run-target-access'

// Render popovers inline so submenu rows exist without Radix portals.
vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverAnchor: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

const openPlansPage = vi.fn()
vi.mock('@/components/billing/plans/plans-page-store', () => ({
  openPlansPage: (source: string) => openPlansPage(source)
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
  description: 'A cloud VM run by Orca.',
  provider: 'orca-cloud',
  create: 'orca-cloud create'
}
const devbox: EphemeralVmRecipeOption = { id: 'devbox', name: 'Devbox', create: './create.sh' }

let container: HTMLDivElement
let root: Root

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

function activeText(): string | null | undefined {
  const id = input().getAttribute('aria-activedescendant')
  return id ? document.getElementById(id)?.textContent : null
}

function render(
  access: OrcaCloudRunTargetAccess | undefined,
  onRecipeChange = vi.fn(),
  onAddRemoteServer = vi.fn(),
  {
    recipes = [cloud, devbox],
    availability = 'offered'
  }: { recipes?: EphemeralVmRecipeOption[]; availability?: OrcaCloudAvailability } = {}
): void {
  act(() => {
    root.render(
      <TooltipProvider>
        <RunTargetCombobox
          hostOptions={hosts}
          hostValue="mac"
          hostExecutionHostId="local"
          recipes={recipes}
          orcaCloudAvailability={availability}
          recipeValue={null}
          onRecipeChange={onRecipeChange}
          onAddSshHost={() => {}}
          onAddRemoteServer={onAddRemoteServer}
          {...(access ? { orcaCloudAccess: access } : {})}
        />
      </TooltipProvider>
    )
  })
  act(() => {
    input().focus()
  })
}

beforeEach(() => {
  openPlansPage.mockClear()
  resetOrcaCloudBillingCache()
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

describe('RunTargetCombobox', () => {
  it('lists Orca Cloud as its own row, not inside the recipe submenu', () => {
    render({ state: 'entitled', remainingSeconds: 12 * 3600 })
    const recipeLists = [...container.querySelectorAll('[role="listbox"]')].filter(
      (list) => list.getAttribute('aria-label') === 'Custom environments'
    )
    expect(recipeLists).toHaveLength(1)
    expect(recipeLists[0]?.textContent).toContain('Devbox')
    expect(recipeLists[0]?.textContent).not.toContain('Orca Cloud')
  })

  it('selects Orca Cloud through its recipe when entitled', () => {
    const onRecipeChange = vi.fn()
    render({ state: 'entitled', remainingSeconds: 3600 }, onRecipeChange)
    press('ArrowDown')
    expect(activeText()).toContain('Orca Cloud')
    press('Enter')
    expect(onRecipeChange).toHaveBeenCalledWith('cloud')
    expect(openPlansPage).not.toHaveBeenCalled()
  })

  it('opens the plans page instead of building when there is no plan', () => {
    const onRecipeChange = vi.fn()
    render({ state: 'no-plan', lapsed: false }, onRecipeChange)
    press('ArrowDown')
    press('Enter')
    expect(openPlansPage).toHaveBeenCalledWith('sandbox')
    expect(onRecipeChange).not.toHaveBeenCalled()
  })

  it('moves keyboard focus into the recipe submenu and commits a recipe with Enter', () => {
    const onRecipeChange = vi.fn()
    render({ state: 'entitled', remainingSeconds: 3600 }, onRecipeChange)
    press('ArrowDown')
    press('ArrowDown')
    expect(activeText()).toContain('Custom environments')
    press('ArrowRight')
    expect(activeText()).toContain('Devbox')
    press('ArrowLeft')
    expect(activeText()).toContain('Custom environments')
    press('Enter')
    expect(activeText()).toContain('Devbox')
    press('Enter')
    expect(onRecipeChange).toHaveBeenCalledWith('devbox')
  })

  it('reaches Add host submenu rows by keyboard', () => {
    const onAddRemoteServer = vi.fn()
    render({ state: 'unknown' }, vi.fn(), onAddRemoteServer)
    for (let i = 0; i < 3; i++) {
      press('ArrowDown')
    }
    expect(activeText()).toContain('Add host')
    press('Enter')
    expect(activeText()).toContain('Add SSH host')
    press('ArrowDown')
    expect(activeText()).toContain('Add remote Orca server')
    press('Enter')
    expect(onAddRemoteServer).toHaveBeenCalledTimes(1)
  })

  it('offers sign-in on the Orca Cloud row when nobody is signed in', () => {
    const connect = vi.fn(async () => null)
    useAppStore.setState({ connectCurrentOrcaProfile: connect })
    const onRecipeChange = vi.fn()
    render(undefined, onRecipeChange, vi.fn(), {
      recipes: [devbox],
      availability: 'needs-sign-in'
    })
    press('ArrowDown')
    expect(activeText()).toContain('Sign in to start a sandbox')
    press('Enter')
    expect(connect).toHaveBeenCalledTimes(1)
    expect(onRecipeChange).not.toHaveBeenCalled()
  })

  function deferBilling(): (value: unknown) => void {
    let answer!: (value: unknown) => void
    const previous = window.api
    window.api = {
      ...previous,
      orcaProfiles: {
        ...previous?.orcaProfiles,
        billingStatus: vi.fn(() => new Promise((resolve) => (answer = resolve)))
      }
    } as never
    onTestFinished(() => {
      window.api = previous
    })
    return (value) => answer(value)
  }
  const NO_PLAN = {
    status: 'ok',
    entitlement: { canStartSandbox: false, reason: 'no_subscription', canManageBilling: true }
  }

  it('holds a pick made while billing loads, then routes a no-plan account to plans', async () => {
    const answer = deferBilling()
    const onRecipeChange = vi.fn()
    render(undefined, onRecipeChange)
    press('ArrowDown')
    press('Enter')
    expect(onRecipeChange).not.toHaveBeenCalled()
    expect(openPlansPage).not.toHaveBeenCalled()

    await act(async () => answer(NO_PLAN))

    expect(openPlansPage).toHaveBeenCalledWith('sandbox')
    expect(onRecipeChange).not.toHaveBeenCalled()
  })

  it('drops a held pick once the user backs out before billing answers', async () => {
    const answer = deferBilling()
    render(undefined)
    press('ArrowDown')
    press('Enter')
    press('Escape')

    await act(async () => answer(NO_PLAN))

    expect(openPlansPage).not.toHaveBeenCalled()
  })

  it('does nothing when a member who cannot fix the block picks Orca Cloud', () => {
    const onRecipeChange = vi.fn()
    render({ state: 'out-of-hours', cause: 'hours', canManageBilling: false }, onRecipeChange)
    press('ArrowDown')
    expect(
      document
        .getElementById(input().getAttribute('aria-activedescendant') ?? '')
        ?.getAttribute('aria-disabled')
    ).toBe('true')
    press('Enter')
    expect(onRecipeChange).not.toHaveBeenCalled()
    expect(openPlansPage).not.toHaveBeenCalled()
  })

  it('jumps to the ends of the list with Home and End', () => {
    render({ state: 'unknown' })
    press('End')
    expect(activeText()).toContain('Add host')
    press('Home')
    expect(activeText()).toContain('Local Mac')
  })
})
