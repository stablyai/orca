// @vitest-environment happy-dom
// Neil: an asleep cloud workspace's menu showed "Sleep" (the local close-panels item) beside "Wake".
// A cloud row gets one lifecycle item for its state; local VM workspaces are unchanged.
import { cleanup, render, screen } from '@testing-library/react'
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

type MenuState = {
  runtime: null | { status: string; canSuspend?: boolean }
  waking: boolean
  ownedCloud: boolean
  archived: boolean
}

const { state } = vi.hoisted(() => {
  const initial: MenuState = { runtime: null, waking: false, ownedCloud: false, archived: false }
  return { state: initial }
})

vi.mock('@/store', () => ({
  useAppStore: (select: (s: unknown) => unknown) =>
    select({
      ephemeralVmRuntimesByWorkspaceId: state.runtime ? { w: state.runtime } : {},
      wakingEphemeralVmWorkspaceIds: state.waking ? { w: true } : {}
    })
}))
vi.mock('@/lib/orca-cloud/orca-cloud-workspace-store', () => ({
  useIsCloudWorkspace: () => state.ownedCloud,
  useCloudWorkspace: () => state.archived
}))
vi.mock('@/lib/workspace/activation/sidebar-worktree-activation', () => ({
  resumeEphemeralVmWorkspace: vi.fn(),
  suspendEphemeralVmWorkspace: vi.fn()
}))
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: ({ children, disabled }: { children: React.ReactNode; disabled?: boolean }) => (
    <div role="menuitem" aria-disabled={disabled || undefined}>
      {children}
    </div>
  )
}))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null
}))

import { WorkspaceVmLifecycleMenuItems } from './WorkspaceVmLifecycleMenuItems'

const PANEL_SLEEP = <div role="menuitem">Close panels sleep</div>

function items({ hasSleepableActivity = true } = {}): string[] {
  render(
    <WorkspaceVmLifecycleMenuItems
      worktreeId="w"
      hasSleepableActivity={hasSleepableActivity}
      disabled={false}
      onSleep={vi.fn()}
      hasActiveDescendants={false}
      onSleepSubtree={vi.fn()}
      sleepItems={PANEL_SLEEP}
      replacesSleep
    />
  )
  return screen.queryAllByRole('menuitem').map((item) => {
    const label = item.textContent ?? ''
    return item.getAttribute('aria-disabled') ? `${label} (disabled)` : label
  })
}

function set(patch: Partial<MenuState>): void {
  Object.assign(state, { runtime: null, waking: false, ownedCloud: false, archived: false }, patch)
}

afterEach(cleanup)

describe('a cloud workspace has one lifecycle item for its state', () => {
  it('running: Sleep, without the local close-panels Sleep', () => {
    set({ ownedCloud: true, runtime: { status: 'running' } })
    expect(items()).toEqual(['Sleep'])
  })

  it('asleep with restored panels: Wake only (the bug: Sleep and Wake together)', () => {
    set({ ownedCloud: true, runtime: { status: 'suspended' } })
    expect(items()).toEqual(['Wake'])
  })

  it('waking: Waking…, disabled', () => {
    set({ ownedCloud: true, runtime: { status: 'suspended' }, waking: true })
    expect(items()).toEqual(['Waking… (disabled)'])
  })

  it('a wake that failed: Try waking again', () => {
    set({ ownedCloud: true, runtime: { status: 'resume_failed' } })
    expect(items()).toEqual(['Try waking again'])
  })

  it('transitioning (provisioning): no lifecycle item, not the local Sleep', () => {
    set({ ownedCloud: true, runtime: { status: 'provisioning' } })
    expect(items()).toEqual([])
  })

  it('paired (no VM record here): its Sleep is the one that reaches the sandbox', () => {
    set({ runtime: null })
    expect(items()).toEqual(['Close panels sleep'])
  })

  it('archived: nothing', () => {
    set({ ownedCloud: true, runtime: { status: 'running' }, archived: true })
    expect(items()).toEqual([])
  })
})

describe('local workspaces are unchanged', () => {
  it('no VM: the close-panels Sleep', () => {
    set({})
    expect(items()).toEqual(['Close panels sleep'])
  })

  it('a suspended local VM with restored panels keeps both Sleep and Resume VM', () => {
    set({ runtime: { status: 'suspended' } })
    expect(items()).toEqual(['Close panels sleep', 'Resume VM'])
  })

  it('a running local VM: Suspend VM in place of Sleep', () => {
    set({ runtime: { status: 'running' } })
    expect(items()).toEqual(['Suspend VM'])
  })
})
