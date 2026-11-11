// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CloudDotState } from '@/lib/orca-cloud/orca-cloud-workspace-state'

const view = vi.hoisted(() => {
  const initial: { isCloud: boolean; state: CloudDotState } = { isCloud: true, state: 'running' }
  return initial
})

vi.mock('@/components/orca-cloud/use-cloud-workspace-view', () => ({
  useCloudWorkspaceView: () => ({
    isCloud: view.isCloud,
    state: view.state,
    entry: undefined,
    wake: undefined,
    oom: null,
    pending: undefined
  })
}))
vi.mock('@/store', () => ({
  useAppStore: (select: (state: { ephemeralVmRuntimesByWorkspaceId: object }) => unknown) =>
    select({ ephemeralVmRuntimesByWorkspaceId: {} })
}))

import { WorktreeCardHostStateWord } from './WorktreeCardHostMark'
import {
  clearWorktreeGoingToSleep,
  markWorktreeGoingToSleep,
  resetWorktreeSleepViewForTests
} from '@/lib/worktree-sleep-view'

const word = (container: HTMLElement): Element | null =>
  container.querySelector('[data-host-state-word]')

describe('the sidebar row state word', () => {
  afterEach(() => {
    cleanup()
    resetWorktreeSleepViewForTests()
    view.isCloud = true
    view.state = 'running'
  })

  it('says "Going to sleep…" from Sleep until the sandbox reads asleep', () => {
    const { container, rerender } = render(<WorktreeCardHostStateWord worktreeId="ws" />)
    expect(word(container)).toBeNull()
    act(() => markWorktreeGoingToSleep('ws'))
    expect(word(container)?.textContent).toBe('Going to sleep…')
    expect(word(container)?.getAttribute('data-host-state-word')).toBe('goingToSleep')
    // The suspended record lands before the sleep ends: the real state wins.
    view.state = 'sleeping'
    rerender(<WorktreeCardHostStateWord worktreeId="ws" />)
    expect(word(container)?.textContent).toBe('Asleep')
    act(() => clearWorktreeGoingToSleep('ws'))
    expect(word(container)?.textContent).toBe('Asleep')
  })

  it('names nothing for another workspace going to sleep, or a non-cloud row', () => {
    const { container, rerender } = render(<WorktreeCardHostStateWord worktreeId="ws" />)
    act(() => markWorktreeGoingToSleep('other'))
    expect(word(container)).toBeNull()
    view.isCloud = false
    act(() => markWorktreeGoingToSleep('ws'))
    rerender(<WorktreeCardHostStateWord worktreeId="ws" />)
    expect(word(container)).toBeNull()
  })
})
