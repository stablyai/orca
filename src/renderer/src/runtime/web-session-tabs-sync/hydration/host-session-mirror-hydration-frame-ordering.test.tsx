// @vitest-environment happy-dom

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

import { useAppStore } from '@/store/index'
import '@/lib/agent-session/resume/resume-sleeping-agent-session'
import '@/components/terminal/background-terminal-worktree-mount'
import '@/lib/agent-session/resume/wake-sleeping-agents-in-background'
import {
  BG_MIRROR_TAB_ID,
  BG_WT,
  ENV,
  HOST_PARENT_TAB_ID,
  HOST_SURFACE_ID,
  LEAF_ID,
  MIRROR_TAB_ID,
  makeHostSnapshot,
  WT
} from './testing/host-session-mirror-frame-fixtures'
import {
  findSubscription,
  installFrameOrderingHarness,
  publish,
  runtimeCall,
  settle
} from './testing/host-session-mirror-frame-ordering-test-harness'
import '../tracking-lifecycle'
import { useWebSessionTabsSync } from '../use-web-session-tabs-sync'
import '../state'
import './host-session-mirror-hydration'
import '../../../lib/window-activity/window-park-visibility'

// Waiters drain synchronously: settle only after frame patch commits or recovery sees empty bindings and duplicates resume. Real handlers also verify unverifiable never settles as exited.
describe('mirrored-pane resume deferral against real stream frames', () => {
  installFrameOrderingHarness()

  it('does not let late bootstrap inventory restore a pre-restart terminal handle', async () => {
    let resolveListAll: (response: unknown) => void = () => {}
    runtimeCall.mockImplementation((request: { method: string }) =>
      request.method === 'session.tabs.listAll'
        ? new Promise((resolve) => {
            resolveListAll = resolve
          })
        : new Promise(() => {})
    )
    renderHook(() => useWebSessionTabsSync())
    await act(settle)

    const beforeRestart = makeHostSnapshot(WT, HOST_SURFACE_ID, HOST_PARENT_TAB_ID)
    beforeRestart.publicationEpoch = 'before-restart'
    if (beforeRestart.tabs[0]?.type !== 'terminal') {
      throw new Error('fixture must contain a terminal surface')
    }
    beforeRestart.tabs[0].terminal = 'terminal-before-restart'
    const afterRestart = makeHostSnapshot(WT, HOST_SURFACE_ID, HOST_PARENT_TAB_ID)
    afterRestart.publicationEpoch = 'after-restart'
    if (afterRestart.tabs[0]?.type !== 'terminal') {
      throw new Error('fixture must contain a terminal surface')
    }
    afterRestart.tabs[0].terminal = 'terminal-after-restart'
    const afterRestartPtyId = `remote:${ENV}@@terminal-after-restart`

    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'updated',
      ...afterRestart
    })
    expect(useAppStore.getState().ptyIdsByTabId[MIRROR_TAB_ID]).toEqual([afterRestartPtyId])

    await act(async () => {
      resolveListAll({
        id: 'listall-before-restart',
        ok: true as const,
        result: { snapshots: [beforeRestart] },
        _meta: { runtimeId: 'runtime-a' }
      })
      await settle()
    })

    const state = useAppStore.getState()
    expect(state.ptyIdsByTabId[MIRROR_TAB_ID]).toEqual([afterRestartPtyId])
    expect(state.tabsByWorktree[WT]?.find((tab) => tab.id === MIRROR_TAB_ID)?.ptyId).toBe(
      afterRestartPtyId
    )
    expect(state.terminalLayoutsByTabId[MIRROR_TAB_ID]?.ptyIdsByLeafId?.[LEAF_ID]).toBe(
      afterRestartPtyId
    )
  })

  it('does not let a late bootstrap runtime id retire a newer stream runtime', async () => {
    let resolveListAll: (response: unknown) => void = () => {}
    runtimeCall.mockImplementation((request: { method: string }) =>
      request.method === 'session.tabs.listAll'
        ? new Promise((resolve) => {
            resolveListAll = resolve
          })
        : new Promise(() => {})
    )
    renderHook(() => useWebSessionTabsSync())
    await act(settle)

    const backgroundParentTabId = 'host-tab-2'
    const backgroundSurfaceId = `${backgroundParentTabId}::${LEAF_ID}`
    const firstRuntimeB = makeHostSnapshot(BG_WT, backgroundSurfaceId, backgroundParentTabId)
    firstRuntimeB.publicationEpoch = 'runtime-b-epoch'
    if (firstRuntimeB.tabs[0]?.type !== 'terminal') {
      throw new Error('fixture must contain a terminal surface')
    }
    firstRuntimeB.tabs[0].terminal = 'runtime-b-terminal-1'
    await publish(
      findSubscription('session.tabs.subscribeAll'),
      { type: 'updated', ...firstRuntimeB },
      'runtime-b'
    )

    const lateRuntimeA = makeHostSnapshot(WT, HOST_SURFACE_ID, HOST_PARENT_TAB_ID)
    lateRuntimeA.publicationEpoch = 'runtime-a-epoch'
    if (lateRuntimeA.tabs[0]?.type !== 'terminal') {
      throw new Error('fixture must contain a terminal surface')
    }
    lateRuntimeA.tabs[0].terminal = 'runtime-a-terminal'
    await act(async () => {
      resolveListAll({
        id: 'listall-after-runtime-restart',
        ok: true as const,
        result: { snapshots: [lateRuntimeA] },
        _meta: { runtimeId: 'runtime-a' }
      })
      await settle()
    })

    const secondRuntimeB = makeHostSnapshot(BG_WT, backgroundSurfaceId, backgroundParentTabId)
    secondRuntimeB.publicationEpoch = 'runtime-b-epoch'
    secondRuntimeB.snapshotVersion = 2
    if (secondRuntimeB.tabs[0]?.type !== 'terminal') {
      throw new Error('fixture must contain a terminal surface')
    }
    secondRuntimeB.tabs[0].terminal = 'runtime-b-terminal-2'
    await publish(
      findSubscription('session.tabs.subscribeAll'),
      { type: 'updated', ...secondRuntimeB },
      'runtime-b'
    )

    expect(useAppStore.getState().ptyIdsByTabId[BG_MIRROR_TAB_ID]).toEqual([
      `remote:${ENV}@@runtime-b-terminal-2`
    ])
  })
})
