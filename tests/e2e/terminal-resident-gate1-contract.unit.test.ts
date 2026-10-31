// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resolveRemoteForegroundEvidence } from '../../src/main/providers/agent-foreground-process-batch'
import { TerminalResidentRegistry } from '../../src/renderer/src/components/terminal-pane/terminal-resident-registry'
import { createTerminalResidentPolicy } from '../../src/renderer/src/components/terminal-pane/terminal-resident-policy'
import { createInitialStoreState } from '../../src/renderer/src/components/terminal-pane/pty-connection-test-store-fixtures'
import { makePaneKey } from '../../src/shared/stable-pane-id'
import {
  LEAF_1,
  createPane,
  createManager
} from '../../src/renderer/src/components/terminal-pane/pty-connection-test-pane-fixtures'
import type { StoreState } from '../../src/renderer/src/components/terminal-pane/pty-connection-test-store-state'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '../../src/renderer/src/components/terminal-pane/pty-connection-test-environment'
import { createTerminalKeyboardRuntime } from '../../src/renderer/src/components/terminal-pane/terminal-keyboard-runtime'
import { createTerminalLayoutActions } from '@/store/terminals/terminal-layout-state'
import { foregroundAgentForActions } from '../../src/shared/agent-status-identity'
import { hasCtrlEnterCsiUAuthorityForPane } from '../../src/renderer/src/components/terminal-pane/terminal-ctrl-enter'
import { resolveWindowsShiftEnterEncodingForPane } from '../../src/renderer/src/components/terminal-pane/terminal-windows-shift-enter'

let state: StoreState & Parameters<typeof resolveWindowsShiftEnterEncodingForPane>[0]
const read = vi.fn<() => Promise<RuntimeTerminalProcessInspection>>()
vi.mock('@/store', () => ({
  useAppStore: { getState: () => state, subscribe: () => () => {} }
}))
vi.mock('../../src/renderer/src/components/terminal-pane/use-notification-dispatch', () => ({
  dispatchTerminalNotification: vi.fn()
}))

const paneKey = makePaneKey('tab-1', LEAF_1)
let epoch = 0
function hostRead(foreground: 'pi' | null): RuntimeTerminalProcessInspection {
  const foregroundPgid = foreground ? 200 : 300
  const root = {
    pid: 100,
    ppid: 1,
    pgid: 100,
    tpgid: foregroundPgid,
    tty: '/dev/pts/2',
    startTime: 'shell-start',
    stat: 'Ss',
    command: '/bin/zsh'
  }
  const evidence = resolveRemoteForegroundEvidence(
    { rootPid: 100, fallbackProcess: 'zsh' },
    {
      ptyId: 'terminal-1',
      ptyIncarnationId: 'inc-1',
      authorityGeneration: 'host-1',
      observationEpoch: ++epoch,
      capturedAgeMs: 0,
      platform: 'linux'
    },
    [
      root,
      { ...root, pid: 200, ppid: 100, pgid: 200, stat: 'S', command: 'pi', startTime: 'pi-start' },
      ...(foreground
        ? []
        : [
            {
              ...root,
              pid: 300,
              ppid: 200,
              pgid: 300,
              stat: 'S+',
              command: 'sleep 60',
              startTime: 'sleep-start'
            }
          ])
    ]
  )
  expect(evidence.verdict).toBe('live')
  return {
    foregroundProcess: evidence.verdict === 'live' ? evidence.processName : null,
    hasChildProcesses: true,
    foregroundProcessEvidence: evidence
  }
}
let end: (() => void) | undefined
function resident() {
  const registry = new TerminalResidentRegistry<ReturnType<typeof createTerminalResidentPolicy>>()
  const current = registry.admit(
    {
      endpoint: 'local',
      executionHost: 'ssh:host-1',
      ptyId: 'ssh:host-1@@terminal-1',
      incarnationId: 'inc-1',
      runtimeId: null
    },
    (captured) =>
      createTerminalResidentPolicy(
        { paneKey, worktreeId: 'wt-1', tabId: 'tab-1', cwd: '/tmp/wt-1' },
        captured.identity,
        () => captured.isLive,
        {
          setCacheTimerStartedAt: vi.fn(),
          markTerminalBell: vi.fn(),
          dispatchNotification: vi.fn()
        }
      )
  )
  state.ptyIdsByTabId!['tab-1'] = [current.identity.ptyId]
  state.terminalLayoutsByTabId!['tab-1']!.ptyIdsByLeafId = { [LEAF_1]: current.identity.ptyId }
  end = () => registry.retire(current)
  return current
}
beforeEach(async () => {
  vi.useFakeTimers()
  epoch = 0
  state = { ...createInitialStoreState(() => state), agentLaunchConfigByPaneKey: {} }
  await installTerminalTestGlobals()
  vi.mocked(window.api.pty.inspectProcess).mockImplementation(() => read())
  read.mockReset()
  read.mockImplementation(async () => hostRead('pi'))
})
afterEach(async () => {
  end?.()
  end = undefined
  await restoreTerminalTestGlobals()
  vi.clearAllTimers()
  vi.useRealTimers()
})

it('discovers a no-OSC manual alias through the existing zero-port resident accepted-input boundary', async () => {
  const owner = resident()
  owner.policy.acceptInput('my-agent-alias\r')
  expect(read).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(350)
  expect(read).toHaveBeenCalledOnce()
  expect(state.paneForegroundAgentByPaneKey[paneKey]?.agent).toBe('pi')
})

it('retains actual observed Pi across nested C and every fresh live/null rung on the SAME resident', async () => {
  const owner = resident()
  const parser = owner.policy.legacySource
  const foreground = owner.policy.foreground.paneForegroundAgentTracker
  owner.policy.observeLegacyData('\x1b]133;C\x07')
  await vi.advanceTimersByTimeAsync(350)
  expect(state.paneForegroundAgentByPaneKey[paneKey]).toMatchObject({
    agent: 'pi',
    agentEvidence: 'process-read'
  })
  expect(read).toHaveBeenCalledOnce()
  read.mockImplementation(async () => hostRead(null))
  owner.policy.observeLegacyData('\x1b]133;C\x07')
  await vi.advanceTimersByTimeAsync(350 + 1200 + 6000)
  expect(read).toHaveBeenCalledTimes(4)
  expect(owner.isLive).toBe(true)
  expect(owner.policy.legacySource).toBe(parser)
  expect(owner.policy.foreground.paneForegroundAgentTracker).toBe(foreground)
  expect(foreground.hasReadInFlight()).toBe(false)
  expect(state.paneForegroundAgentByPaneKey[paneKey]).toMatchObject({
    agent: 'pi',
    agentEvidence: 'process-admitted',
    routingTrusted: false,
    routingConfirmationPending: false
  })
  expect(foregroundAgentForActions(state.paneForegroundAgentByPaneKey[paneKey])).toBeNull()
  read.mockImplementation(async () => hostRead('pi'))
  owner.policy.acceptInput('\r')
  await vi.advanceTimersByTimeAsync(350)
  expect(state.paneForegroundAgentByPaneKey[paneKey]).toMatchObject({
    agent: 'pi',
    agentEvidence: 'process-read',
    routingTrusted: true
  })
})

it('does not treat retained Command Code display as positive output ownership at the actual resident caller', () => {
  const owner = resident()
  state.ptyIdsByTabId!['tab-1'] = [owner.identity.ptyId]
  state.terminalLayoutsByTabId!['tab-1']!.ptyIdsByLeafId = { [LEAF_1]: owner.identity.ptyId }
  state.repos[0]!.connectionId = 'host-1'
  state.sshConnectionStates.set('host-1', { status: 'connected' })
  state.tabsByWorktree['wt-1'][0]!.launchAgent = 'pi'
  state.setPaneForegroundAgent(paneKey, {
    agent: 'command-code',
    agentEvidence: 'process-admitted',
    shellForeground: false
  })
  owner.policy.commandCode.onCommandCodeWorking('must not own')
  expect(state.setAgentStatus).not.toHaveBeenCalled()
  delete state.paneForegroundAgentByPaneKey[paneKey]
  owner.policy.commandCode.onCommandCodeWorking('same independent owner')
  expect(state.setAgentStatus).not.toHaveBeenCalled()
  state.setPaneForegroundAgent(paneKey, {
    agent: 'command-code',
    agentEvidence: 'process-read',
    shellForeground: false
  })
  owner.policy.commandCode.onCommandCodeWorking('actual current read')
  expect(state.setAgentStatus).toHaveBeenCalledOnce()
})

it('keeps ordinary passive routing neutral to independent strict titles and genuine revocation distinct', () => {
  const passive = {
    agent: 'command-code' as const,
    agentEvidence: 'process-admitted' as const,
    shellForeground: false
  }
  state.setPaneForegroundAgent(paneKey, passive)
  const ctrl = hasCtrlEnterCsiUAuthorityForPane(state, paneKey, 'Grok')
  const shift = resolveWindowsShiftEnterEncodingForPane(state, paneKey, 'Pi')
  delete state.paneForegroundAgentByPaneKey[paneKey]
  expect(hasCtrlEnterCsiUAuthorityForPane(state, paneKey, 'Grok')).toBe(ctrl)
  expect(resolveWindowsShiftEnterEncodingForPane(state, paneKey, 'Pi')).toBe(shift)
  expect(ctrl).toBe(true)
  expect(shift).toBe('csi-u')
  state.setPaneForegroundAgent(paneKey, { ...passive, routingRevoked: true })
  expect(hasCtrlEnterCsiUAuthorityForPane(state, paneKey, 'Grok')).toBe(false)
  expect(resolveWindowsShiftEnterEncodingForPane(state, paneKey, 'Pi')).toBe('alt-enter')
})

it('withdraws only the captured publication at actual end and rejects a held read after end', async () => {
  const owner = resident()
  owner.policy.acceptInput('alias\r')
  await vi.advanceTimersByTimeAsync(350)
  const original = state.paneForegroundAgentByPaneKey[paneKey]
  let resolve: (value: RuntimeTerminalProcessInspection) => void = () => {}
  read.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  owner.policy.acceptInput('\r')
  await vi.advanceTimersByTimeAsync(350)
  end?.()
  expect(owner.isLive).toBe(false)
  expect(state.paneForegroundAgentByPaneKey[paneKey]).toBeUndefined()
  resolve(hostRead('pi'))
  await vi.advanceTimersByTimeAsync(0)
  expect(state.paneForegroundAgentByPaneKey[paneKey]).toBeUndefined()
  expect(original?.context?.ptyId).toBe(owner.identity.ptyId)
})

it('routes full-screen keyboard actions with passive equal to absent and independent hooks unchanged', () => {
  const pane = createPane(1)
  pane.terminal.buffer.active.type = 'alternate'
  const manager = createManager(1)
  manager.getActivePane.mockReturnValue(pane)
  state.runtimePaneTitlesByTabId = {}
  // SAFETY: This fixture supplies every dependency reached by Option+Delete classification.
  const runtime = createTerminalKeyboardRuntime({
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    isMac: true,
    isWindows: false,
    shortcutPlatform: 'darwin',
    keyboardScopeRef: { current: null },
    managerRef: { current: manager },
    paneTransportsRef: { current: new Map() },
    panePtyBindingsRef: { current: new Map() },
    paneCwdRef: { current: new Map() },
    fallbackCwd: '/tmp',
    macOptionAsAltRef: { current: 'false' },
    terminalShortcutPolicy: 'orca-first'
  } as never)
  const event = new KeyboardEvent('keydown', { key: 'Delete', code: 'Delete', altKey: true })
  const absent = runtime.resolveShortcutEvent(event)
  state.setPaneForegroundAgent(paneKey, {
    agent: 'codex',
    agentEvidence: 'process-admitted',
    shellForeground: false
  })
  expect(runtime.resolveShortcutEvent(event)).toEqual(absent)
  expect(absent).toBeNull()
  state.setPaneForegroundAgent(paneKey, {
    agent: 'codex',
    agentEvidence: 'process-read',
    shellForeground: false
  })
  expect(runtime.resolveShortcutEvent(event)).toEqual({ type: 'sendInput', data: '\x1bd' })
  state.setPaneForegroundAgent(paneKey, {
    agent: 'codex',
    agentEvidence: 'process-admitted',
    shellForeground: false
  })
  state.runtimePaneTitlesByTabId = { 'tab-1': { 1: 'Codex' } }
  expect(runtime.resolveShortcutEvent(event)).toEqual({ type: 'sendInput', data: '\x1bd' })
})

it.each(['absent', 'partial'] as const)(
  'atomically retracts a removed rowless leaf with %s inventory, rejects its held response and preserves sibling and execution',
  async (inventory) => {
    const owner = resident()
    owner.policy.acceptInput('alias\r')
    await vi.advanceTimersByTimeAsync(350)
    const original = state.paneForegroundAgentByPaneKey[paneKey]
    let resolve!: (value: RuntimeTerminalProcessInspection) => void
    read.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    owner.policy.acceptInput('next\r')
    await vi.advanceTimersByTimeAsync(350)
    const sibling = '22222222-2222-4222-8222-222222222222'
    const siblingKey = makePaneKey('tab-1', sibling)
    const siblingEntry = { agent: 'codex' as const, shellForeground: false }
    state.setPaneForegroundAgent(siblingKey, siblingEntry)
    const tracker = owner.policy.foreground.paneForegroundAgentTracker
    expect(read).toHaveBeenCalledTimes(2)
    expect(tracker.hasReadInFlight()).toBe(true)
    expect(original?.context?.execution).toBeDefined()
    if (inventory === 'absent') {
      delete state.terminalLayoutsByTabId!['tab-1']
    } else {
      state.terminalLayoutsByTabId!['tab-1'] = {
        root: { type: 'leaf', leafId: sibling },
        activeLeafId: sibling,
        expandedLeafId: null
      }
    }
    // SAFETY: The real layout action only reads/writes the supplied terminal and foreground slices.
    const actions = createTerminalLayoutActions(
      (update) => {
        Object.assign(state, typeof update === 'function' ? update(state as never) : update)
      },
      () => state as never
    )
    actions.setTabLayout('tab-1', {
      root: { type: 'leaf', leafId: sibling },
      activeLeafId: sibling,
      expandedLeafId: sibling
    })
    expect(state.paneForegroundAgentByPaneKey[paneKey]).toBeUndefined()
    expect(state.paneForegroundAgentByPaneKey[siblingKey]).toBe(siblingEntry)
    expect(owner.isLive).toBe(true)
    resolve(hostRead('pi'))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(state.paneForegroundAgentByPaneKey[paneKey]).toBeUndefined()
    expect(owner.policy.foreground.paneForegroundAgentTracker.hasReadInFlight()).toBe(false)
    expect(original?.agentEvidence).toBe('process-read')
    expect(owner.isLive).toBe(true)
    expect(owner.policy.foreground.paneForegroundAgentTracker).toBe(tracker)
    expect(state.paneForegroundAgentByPaneKey[siblingKey]).toBe(siblingEntry)
    expect(read).toHaveBeenCalledTimes(2)
  }
)
