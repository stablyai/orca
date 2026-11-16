// @vitest-environment happy-dom
import '@/store/slices/agent-status/agent-status-projection'

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type * as WebRuntimeTerminalCreationModule from '../../hosted-terminals/creation/web-runtime-terminal-creation'
import type * as WebSessionTerminalHandleEventsModule from '../terminal-handles/web-session-terminal-handle-events'

vi.mock('../terminal-handles/web-session-terminal-handle-events', async (importOriginal) => {
  const actual = await importOriginal<typeof WebSessionTerminalHandleEventsModule>()
  const { frameOrderingMocks } = await import('./testing/host-session-mirror-frame-fixtures')
  return {
    ...actual,
    queueAcceptedWebSessionTerminalSnapshot: frameOrderingMocks.queueAcceptedSnapshot
  }
})

vi.mock('../subscriptions/use-runtime-session-mirror-environment-key', async () => {
  const { frameOrderingMocks } = await import('./testing/host-session-mirror-frame-fixtures')
  return {
    useRuntimeSessionMirrorEnvironmentKeys: () => ({
      environmentKey: frameOrderingMocks.runtimeSessionMirrorEnvironmentKey(),
      resubscribeSignal: ''
    })
  }
})

vi.mock('../../hosted-terminals/recovery/web-session-terminal-orphan-recovery', async () => {
  const { frameOrderingMocks } = await import('./testing/host-session-mirror-frame-fixtures')
  return { recoverWebSessionTerminalOrphansBeforeApply: frameOrderingMocks.recoverSnapshot }
})

vi.mock('../../hosted-terminals/creation/web-runtime-terminal-creation', async (importOriginal) => {
  const actual = await importOriginal<typeof WebRuntimeTerminalCreationModule>()
  const { frameOrderingMocks } = await import('./testing/host-session-mirror-frame-fixtures')
  return {
    ...actual,
    createWebRuntimeSessionTerminal: frameOrderingMocks.createTerminal
  }
})

import '@/store/index'
import '@/lib/agent-session/resume/resume-sleeping-agent-session'
import {
  ENV,
  HOST_PARENT_TAB_ID,
  HOST_SURFACE_ID,
  MIRROR_TAB_ID,
  makeHostSnapshot,
  WT
} from './testing/host-session-mirror-frame-fixtures'
import {
  findSubscription,
  installFrameOrderingHarness,
  publish,
  runtimeCall,
  settle,
  tabIds
} from './testing/host-session-mirror-frame-ordering-test-harness'
import '../../../../../shared/orca-profiles/constants'
import './host-session-mirror-hydration'
import { refreshWebRuntimeSessionTabsSnapshot } from '../inventory/web-runtime-session-snapshot'
import '../tracking-lifecycle'
import { useWebSessionTabsSync } from '../use-web-session-tabs-sync'
import '../state'
import '../../rpc/subscriptions/window-visibility-subscription-parking'

/**
 * The receipt era of the same seam: a settle exists only as the proof of a
 * landed patch, or as the rejection an already-accepted view backs.
 */

describe('the eager post-create list answers for its worktree', () => {
  installFrameOrderingHarness()

  it('does not resurrect a worktree the stream retracted while the list was in flight', async () => {
    // Refresh applies from close/create/activation/split/reconnect need receipt order too; a pre-close list once landed after retraction and resurrected the tab.
    renderHook(() => useWebSessionTabsSync())
    await act(settle)

    let resolveList!: (response: unknown) => void
    runtimeCall.mockImplementation((request: { method: string }) =>
      request.method === 'session.tabs.list'
        ? new Promise((resolve) => {
            resolveList = resolve
          })
        : new Promise(() => {})
    )
    const refreshed = refreshWebRuntimeSessionTabsSnapshot(ENV, WT)
    await act(settle)

    // The close lands on the stream while that list is still out.
    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'snapshot',
      worktree: WT,
      publicationEpoch: `removed:${(1_700_000_000_000).toString(36)}`,
      snapshotVersion: 0,
      removed: true,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    })
    expect(tabIds(WT)).not.toContain(MIRROR_TAB_ID)

    // The pre-close answer arrives last, at a higher version than anything since.
    resolveList({
      id: 'list',
      ok: true as const,
      result: { ...makeHostSnapshot(WT, HOST_SURFACE_ID, HOST_PARENT_TAB_ID), snapshotVersion: 9 },
      _meta: { runtimeId: 'runtime-a' }
    })
    await act(async () => {
      await refreshed
      await settle()
    })

    expect(tabIds(WT)).not.toContain(MIRROR_TAB_ID)
  })
})

// A failed observer cannot undo a landed frame or skip later observers.
