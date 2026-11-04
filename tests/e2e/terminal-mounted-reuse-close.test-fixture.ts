import { vi } from 'vitest'
import { setupRetirementRuntime } from './terminal-retirement-runtime.test-fixture'
import { installAcknowledgedCloseRelay } from '../../src/main/runtime/__fixtures__/orca-runtime-acknowledged-terminal-close.test-fixture'
import { installPtyInspectIpcHandlers } from '../../src/main/ipc/pty/ipc/inspect'
import { installPtySpawnIpcHandler } from '../../src/main/ipc/pty/ipc/spawn'
import { adoptStablePane } from '../../src/main/ipc/pty/pane/adopt-stable'
import {
  getPtyIpc,
  setPtyHostBindings,
  getPtyPower
} from '../../src/main/ipc/pty/pty-host-bindings'
import { localProvider, setLocalPtyProvider } from '../../src/main/ipc/pty/provider/registry'
import { SessionNotFoundError } from '../../src/main/daemon/daemon-errors'
import {
  assertWorkspaceAcceptsNewPty,
  resolvePtySpawnStartupCwd
} from '../../src/main/ipc/pty/host-env/spawn-cwd'
import * as codexResume from '../../src/main/ipc/pty/host-env/codex-resume'
import type { PtySpawnIpcArgs } from '../../src/main/ipc/pty/ipc/spawn-types'

export async function setupMountedReuseClose() {
  const fixture = await setupRetirementRuntime({ naturalPublication: true })
  const { runtime, store, processes } = fixture
  const order: string[] = []
  const relay = await installAcknowledgedCloseRelay(store, runtime, () => order.push('ack'))
  runtime.setNotifier({ ...runtime['notifier']!, closeTerminalTab: relay.closeTerminalTab })
  const ownerResults: {
    ptyIds: string[] | null
    membership: ReturnType<typeof fixture.membership>
  }[] = []
  const prepareOwner = runtime['prepareTerminalSurfaceClose'].bind(runtime)
  runtime['prepareTerminalSurfaceClose'] = (...args) => {
    const complete = prepareOwner(...args)
    return async () => {
      const ptyIds = await complete()
      if (!args[2]?.closedByLayoutOwner) {
        ownerResults.push({ ptyIds, membership: fixture.membership() })
        order.push('runtime-owner-completed')
      }
      return ptyIds
    }
  }
  const controller = runtime['ptyController']!
  const stop = controller.stopAndWait!.bind(controller)
  const stopAndWait = vi.spyOn(controller, 'stopAndWait').mockImplementation((...args) => {
    order.push('captured-stop')
    return stop(...args)
  })
  const kill = vi.spyOn(controller, 'kill')
  const exit = vi.spyOn(runtime, 'onPtyExit')
  const originalProvider = localProvider
  const provider = Object.create(originalProvider) as typeof localProvider
  provider.spawn = async (options) => {
    const process = options.sessionId ? processes.get(options.sessionId) : undefined
    if (!process) {
      throw new SessionNotFoundError(options.sessionId ?? 'unexpected-fresh-spawn')
    }
    if (options.expectedIncarnationId && options.expectedIncarnationId !== process.incarnationId) {
      throw new Error('terminal_pane_owner_changed')
    }
    return { ...process, isReattach: true }
  }
  setLocalPtyProvider(provider)
  const originalIpc = getPtyIpc()
  const originalPower = getPtyPower()
  const spawnHandlers = new Map<string, (...args: any[]) => unknown>()
  setPtyHostBindings({
    ipc: {
      handle: (channel, handler) => {
        spawnHandlers.set(channel, handler)
      },
      on: () => {},
      removeHandler: (channel) => {
        spawnHandlers.delete(channel)
      },
      removeAllListeners: () => {}
    }
  })
  installPtyInspectIpcHandlers({ getLocalPtyProviderStartupPromise: () => undefined })
  const invokePty = async (channel: string, args: unknown) =>
    spawnHandlers.get(channel)!({ sender: relay.sender }, args)
  installPtySpawnIpcHandler({
    runtime,
    store,
    getSettings: () => store.getSettings(),
    getLocalPtyStartupPromise: () => undefined,
    adoptStablePane: (args) => adoptStablePane(runtime, store, args),
    assertWorkspaceAcceptsNewPty: (...args) => assertWorkspaceAcceptsNewPty(store, ...args),
    resolvePtySpawnStartupCwd: (...args) => resolvePtySpawnStartupCwd(store, ...args),
    transitionSpawnHiddenRendererPtyDeliveryState: () => {},
    trustedTerminalHandleEnv: new Set(),
    sendPtySpawnedToRenderer: () => {},
    syncPtyBackgroundedDelivery: () => {},
    stopReplacedPty: async () => {
      throw new Error('unexpected replacement')
    },
    prepareCodexResumeHome: (args) => codexResume.prepareCodexResumeHome(undefined, args),
    resolveCodexResumeLaunch: codexResume.resolveCodexResumeLaunch,
    noCodexResumeLaunch: codexResume.noCodexResumeLaunch,
    reconcileSharedRuntimeResumeHome: codexResume.reconcileSharedRuntimeResumeHome,
    stripSequencedStartupResumeArgv: codexResume.stripSequencedStartupResumeArgv
  })
  let release!: () => void
  const heldReply = new Promise<void>((resolve) => {
    release = resolve
  })
  let completedReply = false
  const spawn = vi.fn(async (args: PtySpawnIpcArgs) => {
    const result = await invokePty('pty:spawn', args)
    completedReply = true
    order.push('main-spawn-result')
    await heldReply
    order.push('delivered-spawn-result')
    return result
  })
  Object.assign(window.api.pty, {
    spawn,
    onData: () => () => {},
    onReplay: () => () => {},
    onExit: () => () => {},
    getCwd: async (id: string) => processes.get(id)?.cwd ?? null,
    resize: () => {},
    write: () => true,
    acknowledgeDataEvent: () => {},
    declarePendingPaneSerializer: (paneKey: string) =>
      invokePty('pty:declarePendingPaneSerializer', { paneKey }),
    settlePaneSerializer: (paneKey: string, gen: number) =>
      invokePty('pty:settlePaneSerializer', { paneKey, gen }),
    clearPendingPaneSerializer: (paneKey: string, gen: number) =>
      invokePty('pty:clearPendingPaneSerializer', { paneKey, gen }),
    reportRendererSerializerReady: (ptyId: string) =>
      invokePty('pty:reportRendererSerializerReady', { ptyId }),
    rendererDispatcherReady: () => {}
  })
  Object.assign(window.api, { platform: 'darwin' })
  return {
    ...fixture,
    order,
    ownerResults,
    stopAndWait,
    kill,
    exit,
    spawn,
    completedReply: () => completedReply,
    release,
    dispose: async () => {
      release()
      relay.dispose()
      setPtyHostBindings({ ipc: originalIpc, power: originalPower })
      setLocalPtyProvider(originalProvider)
      await fixture.dispose()
    }
  }
}
