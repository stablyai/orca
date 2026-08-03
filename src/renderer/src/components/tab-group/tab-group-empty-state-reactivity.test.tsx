// @vitest-environment happy-dom

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const storeBox = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(storeBox.state)
}))

vi.mock('../../lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: (state: { runtimeEnvironmentId?: string | null }) =>
    state.runtimeEnvironmentId ?? null
}))

import {
  clearWebSessionTabsTrackingForEnvironment,
  shouldApplyWebSessionTabsSnapshot
} from '../../runtime/web-session-tabs-sync'
import { useTabGroupEmptyStateVisible } from './tab-group-empty-state-visibility'

const ENV = 'env-reactivity-1'
const WT = 'repo::/tmp/remote-wt'

function Probe(): React.JSX.Element {
  const visible = useTabGroupEmptyStateVisible(WT, 0)
  return <span data-testid="state">{visible ? 'empty-state' : 'hidden'}</span>
}

/** A host snapshot carrying no tabs — the case that moves no store slice. */
function zeroTabSnapshot(): Parameters<typeof shouldApplyWebSessionTabsSnapshot>[0] {
  return {
    worktree: WT,
    tabs: [],
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1
  } as unknown as Parameters<typeof shouldApplyWebSessionTabsSnapshot>[0]
}

beforeEach(() => {
  clearWebSessionTabsTrackingForEnvironment(ENV)
  storeBox.state = { workspaceSessionReady: true, runtimeEnvironmentId: ENV }
})

afterEach(() => {
  cleanup()
  clearWebSessionTabsTrackingForEnvironment(ENV)
})

describe('tab group empty state reactivity', () => {
  it('hides while a runtime-owned worktree still awaits its first host snapshot', () => {
    render(<Probe />)

    expect(screen.getByTestId('state').textContent).toBe('hidden')
  })

  // Why: this is the regression the pure-predicate tests cannot see. A zero-tab snapshot
  // writes no store slice, so only the publication subscription can re-render the pane.
  it('reveals the empty state when a zero-tab snapshot publishes, with no other state change', () => {
    render(<Probe />)
    expect(screen.getByTestId('state').textContent).toBe('hidden')
    const storeStateBefore = storeBox.state

    // Real sync path: records the publication epoch and notifies subscribers.
    act(() => {
      expect(shouldApplyWebSessionTabsSnapshot(zeroTabSnapshot(), ENV)).toBe(true)
    })

    expect(storeBox.state).toBe(storeStateBefore)
    expect(screen.getByTestId('state').textContent).toBe('empty-state')
  })

  it('shows immediately for a local worktree, which never awaits a host', () => {
    storeBox.state = { workspaceSessionReady: true, runtimeEnvironmentId: null }
    render(<Probe />)

    expect(screen.getByTestId('state').textContent).toBe('empty-state')
  })
})
