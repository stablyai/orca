import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { afterEach, vi } from 'vitest'
import {
  closeTestStores,
  createStore,
  testState
} from '../../src/main/persistence/persistence-test-harness'
import { createAgentPromptSubmissionRuntime } from '../../src/main/runtime/agent-prompt-submission-runtime-test-fixture'
import {
  runtimeStub,
  setAgentLaunchRecordStore
} from '../../src/main/runtime/rpc/methods/agent-launch.test-fixture'
import { closeTestJournalHostDatabases } from '../../src/main/native-chat/agent-session-journal/journal-host-database-test-support'
import { openTestAgentSessionRecordStore } from '../../src/main/runtime/agent-session/records/agent-session-record-store-test-harness'
import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import { createRuntimeAutomationService } from '../../src/main/automations/runtime-automation-service'
import {
  attachingRendererViewPtys,
  visibleRendererPtys
} from '../../src/main/ipc/pty/delivery/visibility-state'
import { createHookListenerState } from '../../src/shared/agent-hook-listener/listener-state'
import { normalizeCodexEvent } from '../../src/shared/agent-hook-listener/providers/codex-events'
vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(text),
    decryptString: (bytes: Buffer) => bytes.toString()
  }
}))
const catalogState = vi.hoisted(() => ({ paths: ['/tmp/worktree-a'] }))
export const catalog = catalogState
const worktrees = () =>
  catalog.paths.map((path) => ({
    path,
    head: 'abc',
    branch: 'b',
    isBare: false,
    isMainWorktree: false
  }))
vi.mock('../../src/main/git/worktrees/catalog/worktree-scan-cache', () => ({
  listWorktrees: vi.fn(async () => worktrees()),
  listWorktreesStrict: vi.fn(async () => worktrees())
}))
vi.mock('../../src/main/git/worktrees/catalog/worktree-listing', () => ({
  listWorktreesStrict: vi.fn(async () => worktrees())
}))
const realNow = Date.now
export const retentionNow = () => vi.getMockedSystemTime()?.getTime() ?? realNow()
const directories: string[] = []
export const registerRetentionFixtureDirectory = (path: string) => directories.push(path)
afterEach(async () => {
  catalog.paths = ['/tmp/worktree-a']
  visibleRendererPtys.clear()
  attachingRendererViewPtys.clear()
  vi.useRealTimers()
  setAgentLaunchRecordStore(null)
  vi.restoreAllMocks()
  await closeTestJournalHostDatabases()
  await closeTestStores()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

export async function setup(lineCarriesPrompt = false) {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-reuse-retention-'))
  directories.push(testState.dir)
  const store = createStore()
  store.addRepo({ id: 'r1', path: '/repo', displayName: 'Repo', badgeColor: '#fff', addedAt: 1 })
  const automation = store.createAutomation({
    name: 'Queued audit',
    prompt: 'seed',
    agentId: 'codex',
    enabled: false,
    projectId: 'r1',
    workspaceMode: 'existing',
    workspaceId: 'r1::/tmp/worktree-a',
    reuseSession: true,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: Date.now()
  })
  const queued: string[] = []
  const consumed: string[] = []
  let draft = ''
  // Composed external TUI boundary: Enter queues; admission occurs later. This is not a CLI capture.
  const rig = await createAgentPromptSubmissionRuntime((ptyRuntime, data) => {
    ptyRuntime.onPtyData('pty-prompt', '› draft\n\x1b[?25h', Date.now())
    if (data.includes('\x1b[200~')) {
      draft = data.split('\x1b[200~')[1]!.split('\x1b[201~')[0]!
    }
    if (data.endsWith('\r') && draft) {
      queued.push(draft)
      draft = ''
    }
  }, 'codex')
  const pane = rig.runtime.getTerminalPaneKey(rig.handle)!
  const binding = rig.runtime.getTerminalPromptRequestBinding(rig.handle)
  const listener = createHookListenerState()
  const normalize = (eventName: string, turn: string) =>
    normalizeCodexEvent(listener, eventName, '', pane, { session_id: 'session', turn_id: turn })!
  const control = {
    row: normalize('UserPromptSubmit', 'seed-turn'),
    shell: false,
    wakeupPending: false,
    beforeClose: () => {}
  }
  const stopped: string[] = []
  const close = vi.fn(async (handle: string, options: { beforeAction: () => void }) => {
    await Promise.resolve()
    control.beforeClose()
    options.beforeAction()
    stopped.push(handle)
    return {}
  })
  const records = await openTestAgentSessionRecordStore(join(testState.dir, 'ledger'))
  setAgentLaunchRecordStore(records)
  const external = runtimeStub({ terminalPaneKey: pane, lineCarriesPrompt })
  external.requireStore.mockReturnValue(store)
  external.createTerminal.mockImplementation(async () => {
    // The external controller's spawn commit precedes launch writes, through the real fact owner.
    rig.runtime.terminalRunFacts.recordSpawnCommit({
      id: binding.ptyId,
      incarnationId: binding.processIncarnation
    })
    return { handle: rig.handle, paneKey: pane }
  })
  external.hasLiveTerminalForPaneKey.mockReturnValue(true)
  external.getTerminalHandleForPaneKey.mockImplementation((key) =>
    key === pane ? rig.handle : key
  )
  external.showTerminal.mockResolvedValue({
    handle: rig.handle,
    worktreeId: automation.workspaceId!
  })
  external.showTerminalWorkspaceLaunchScope.mockResolvedValue({
    id: automation.workspaceId!,
    path: '/tmp/worktree-a',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
  const runtime = Object.assign(new OrcaRuntimeService(store), external, {
    resolveManagedTerminalWorkspaceTarget:
      OrcaRuntimeService.prototype.resolveManagedTerminalWorkspaceTarget,
    getTerminalWorktreeIdForHandle: () => automation.workspaceId,
    getPtyExecutionHostMetadata: () => ({ executionHostId: 'local' }),
    getTerminalPromptRequestBinding: rig.runtime.getTerminalPromptRequestBinding.bind(rig.runtime),
    getTerminalPaneKey: () => pane,
    getTerminalPtyIdForHandle: (handle: string) =>
      handle === rig.handle ? (stopped.includes(handle) ? null : binding.ptyId) : `pty:${handle}`,
    getTerminalProcessIncarnation: (handle: string) =>
      handle === rig.handle ? binding.processIncarnation : 'sibling',
    getAgentStatusRowsForPane: (key: string) => [
      {
        ...(key === pane ? control.row : { state: 'done' }),
        claudeTaskWakeupPending: key === pane && control.wakeupPending,
        connectionId: null,
        terminalHandle: key === pane ? rig.handle : key
      }
    ],
    readObservedAgentStatusPaneIdentityFn: (key: string) => ({
      kind: 'observed',
      terminalHandle: key === pane ? rig.handle : key,
      processIncarnation: key === pane ? binding.processIncarnation : 'sibling',
      dispatchId: null
    }),
    readTerminalClientUse: (pty: string) =>
      pty === binding.ptyId ? rig.runtime.readTerminalClientUse(pty) : 'used',
    confirmTerminalShellAlone: vi.fn(async () => control.shell),
    closeTerminal: close,
    sleepTerminalsForWorktree: vi.fn(),
    readLaunchedAgentForeground: rig.runtime.readLaunchedAgentForeground.bind(rig.runtime),
    subscribeToTerminalData: rig.runtime.subscribeToTerminalData.bind(rig.runtime),
    sendTerminalAgentPrompt: rig.runtime.sendTerminalAgentPrompt.bind(rig.runtime),
    waitForTerminal: async () => ({ satisfied: true }),
    showManagedWorktree: async () => ({ displayName: 'Audit' })
  })
  vi.spyOn(Date, 'now').mockImplementation(retentionNow)
  const opened = vi.fn<OrcaRuntimeService['openedAgentSessionRecordStore']>(() => records)
  Object.assign(runtime, {
    events: new EventEmitter(),
    setAutomationService: vi.fn(),
    notifyAutomationsChanged: vi.fn(),
    openedAgentSessionRecordStore: opened
  })
  const service = createRuntimeAutomationService({ store, runtime, headless: false })
  service.setWebContents(
    Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false, send: vi.fn() })
  )
  service.setRendererReady()
  const advance = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms)
    await service.runInAutomationLane(automation.id, async () => {})
  }
  return {
    store,
    automation,
    rig,
    pane,
    binding,
    normalize,
    control,
    close,
    stopped,
    records,
    opened,
    external,
    runtime,
    service,
    advance,
    queued,
    consumed
  }
}
