// @vitest-environment happy-dom
// An asleep cloud workspace's menu showed "Sleep" (the local close-panels item) beside "Wake".
// A cloud row gets one lifecycle item for its state; local VM workspaces are unchanged.
import { cleanup, render, screen } from '@testing-library/react'
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

type MenuState = {
  runtime: null | { status: string; canSuspend?: boolean }
  waking: boolean
  ownedCloud: boolean
  archived: boolean
  /** A paired row and the state its sidebar line shows (CloudDotState). */
  paired: boolean
  cloudDot: string
}

const BLANK: MenuState = {
  runtime: null,
  waking: false,
  ownedCloud: false,
  archived: false,
  paired: false,
  cloudDot: 'unknown'
}

const { state } = vi.hoisted(() => {
  const initial: MenuState = {
    runtime: null,
    waking: false,
    ownedCloud: false,
    archived: false,
    paired: false,
    cloudDot: 'unknown'
  }
  return { state: initial }
})

vi.mock('@/store', () => ({
  useAppStore: (select: (s: unknown) => unknown) =>
    select({
      ephemeralVmRuntimesByWorkspaceId: state.runtime ? { w: state.runtime } : {},
      wakingEphemeralVmWorkspaceIds: state.waking ? { w: true } : {}
    })
}))
// The store's real shape, so the row tests (isPairedCloudStatusRow, isArchivedCloudStatus) run as in the app.
vi.mock('@/lib/orca-cloud/orca-cloud-workspace-store', () => ({
  useIsCloudWorkspace: () => state.ownedCloud,
  useCloudWorkspace: (select: (s: unknown) => unknown) =>
    select({
      ids: new Set(state.ownedCloud ? ['w'] : []),
      paired: state.paired ? { w: 'env-1' } : {},
      status: { w: { status: state.archived ? { state: 'archived' } : null } }
    })
}))
vi.mock('@/components/orca-cloud/use-cloud-workspace-view', () => ({
  useCloudWorkspaceView: () => ({ state: state.cloudDot })
}))
const wakeCloudWorkspace = vi.hoisted(() => vi.fn())
vi.mock('@/components/orca-cloud/cloud-workspace-actions', () => ({ wakeCloudWorkspace }))
vi.mock('@/lib/workspace/activation/sidebar-worktree-activation', () => ({
  resumeEphemeralVmWorkspace: vi.fn(),
  suspendEphemeralVmWorkspace: vi.fn()
}))
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect
  }: {
    children: React.ReactNode
    disabled?: boolean
    onSelect?: () => void
  }) => (
    <div role="menuitem" aria-disabled={disabled || undefined} onClick={onSelect}>
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
  Object.assign(state, BLANK, patch)
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

  // A workspace created from a GitHub-only project is a paired row; asleep
  // it offered Sleep and never Wake, and the menu must read the same state as the sidebar line.
  it('paired and running: the Sleep that reaches the sandbox', () => {
    set({ paired: true, cloudDot: 'running' })
    expect(items()).toEqual(['Close panels sleep'])
  })

  it('paired and asleep: Wake only, which wakes the sandbox', () => {
    set({ paired: true, cloudDot: 'sleeping' })
    expect(items()).toEqual(['Wake'])
    screen.getByText('Wake').click()
    expect(wakeCloudWorkspace).toHaveBeenCalledWith('w')
  })

  it('paired and Waking in the sidebar: Waking…, disabled (not Sleep)', () => {
    set({ paired: true, cloudDot: 'waking' })
    expect(items()).toEqual(['Waking… (disabled)'])
  })

  it('paired after a failed wake: Try waking again', () => {
    set({ paired: true, cloudDot: 'wakeFailed' })
    expect(items()).toEqual(['Try waking again'])
  })

  it('paired and archived: nothing', () => {
    set({ paired: true, archived: true })
    expect(items()).toEqual([])
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
