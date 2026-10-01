import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { connectPanePty } from './pty-connection'
import { createDeferred, flushAsyncTicks } from './pty-connection-test-async'
import { LEAF_1, createManager, createPane } from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'

const { scheduleRuntimeGraphSync, toastInfo, notifyCodexPaneBoundForStaleSweep } = vi.hoisted(
  () => ({
    scheduleRuntimeGraphSync: vi.fn(),
    toastInfo: vi.fn(),
    notifyCodexPaneBoundForStaleSweep: vi.fn()
  })
)

let mockStoreState: StoreState

vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState,
    subscribe: () => () => {}
  }
}))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const { buildAgentStatusModuleMock } = await import('./pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})
vi.mock('./cache-timer-seeding', () => ({ shouldSeedCacheTimerOnInitialTitle: () => false }))
vi.mock('sonner', () => ({ toast: { info: toastInfo } }))
vi.mock('@/lib/codex-stale-pane-sweep', () => ({ notifyCodexPaneBoundForStaleSweep }))
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn
  }
})

const TARGET_ID = 'target-a'
const LIVE_PTY_ID = toAppSshPtyId(TARGET_ID, 'pty-live')

function seedRestoredSshTab(): void {
  mockStoreState = {
    ...mockStoreState,
    tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: LIVE_PTY_ID, generation: 1 }] },
    ptyIdsByTabId: { 'tab-1': [LIVE_PTY_ID] },
    repos: [{ id: 'repo1', connectionId: TARGET_ID, displayName: 'orca' }],
    sshConnectionStates: new Map([
      [
        TARGET_ID,
        {
          targetId: TARGET_ID,
          status: 'connected',
          providerEpoch: 'epoch-1',
          connectionGeneration: 1
        }
      ]
    ])
  }
}

// The real IPC transport, so the pane's input path is exercised end to end down to pty:write.
function installIpcSpawnDoubles(spawn: Promise<unknown>): void {
  Object.assign(window.api.pty, {
    spawn: vi.fn(() => spawn),
    onData: vi.fn(() => () => {}),
    onReplay: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
    onWriteUnavailable: vi.fn(() => () => {}),
    onSideEffect: vi.fn(() => () => {}),
    resize: vi.fn(),
    claimViewport: vi.fn()
  })
}

function connectRestoredSshPane(): {
  typeIntoPane: (text: string) => void
  dispose: () => void
} {
  const pane = createPane(1)
  const binding = connectPanePty(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture types intentionally model the production connection boundary.
    pane as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture types intentionally model the production connection boundary.
    createManager(1) as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture types intentionally model the production connection boundary.
    buildPaneConnectionDeps(() => mockStoreState, {
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: LIVE_PTY_ID }
    }) as never
  )
  return {
    typeIntoPane: (text) => {
      const onData: unknown = vi.mocked(pane.terminal.onData).mock.calls[0]?.[0]
      if (typeof onData !== 'function') {
        throw new Error('pane never subscribed to terminal input')
      }
      for (const char of text) {
        onData(char)
      }
    },
    dispose: () => binding.dispose()
  }
}

describe('restored SSH pane input typed while its reattach is in flight', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStoreState = createInitialStoreState(() => mockStoreState)
    installTerminalTestGlobals()
    seedRestoredSshTab()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  it('delivers the keys in order once the pane reattaches to the live remote shell', async () => {
    const spawn = createDeferred<unknown>()
    installIpcSpawnDoubles(spawn.promise)
    const pane = connectRestoredSshPane()
    await flushAsyncTicks(20)
    expect(window.api.pty.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: LIVE_PTY_ID, connectionId: TARGET_ID })
    )

    pane.typeIntoPane('printf ')
    expect(window.api.pty.write).not.toHaveBeenCalled()

    spawn.resolve({ id: LIVE_PTY_ID, isReattach: true })
    await flushAsyncTicks(20)
    pane.typeIntoPane('ok')
    await flushAsyncTicks(20)

    const delivered = vi
      .mocked(window.api.pty.write)
      .mock.calls.map(([id, data]) => {
        expect(id).toBe(LIVE_PTY_ID)
        return data
      })
      .join('')
    expect(delivered).toBe('printf ok')
    pane.dispose()
  })

  it('drops the keys with a warning when the reattach finds the shell gone', async () => {
    const spawn = createDeferred<unknown>()
    installIpcSpawnDoubles(spawn.promise)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const pane = connectRestoredSshPane()
    await flushAsyncTicks(20)
    pane.typeIntoPane('rm -rf x')

    // The relay no longer has the PTY, so the pane falls back to a fresh shell.
    vi.mocked(window.api.pty.spawn).mockResolvedValue({ id: toAppSshPtyId(TARGET_ID, 'pty-new') })
    spawn.reject(new Error(`PTY "pty-live" not found`))
    await flushAsyncTicks(40)

    expect(window.api.pty.write).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        '[pty-transport] dropped keys typed while the terminal was connecting'
      )
    )
    pane.dispose()
  })
})
