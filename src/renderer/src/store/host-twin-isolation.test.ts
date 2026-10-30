/** Twin-targeted actions must isolate survivors. Keep the hand-declared action table current; KNOWN_TWIN_LEAKS pins Stage 1 failures, so fixes require removing their entries. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../runtime/runtime-rpc-client'
import { hasWorktreeSleepIntent } from '@/lib/worktree-sleep-intent'
import {
  changedHostTwinState,
  projectHostTwinState,
  resetHostTwinModuleStores
} from './host-twin-state-projection.test-fixture'
import {
  createHostTwinFixture,
  TWIN_RUNTIME_ENV,
  type HostTwinFixture,
  type HostTwinKind,
  type HostTwinSide
} from './host-twin.test-fixture'

const appStore = vi.hoisted((): { current: HostTwinFixture['store'] | null } => ({
  current: null
}))

// Why: the sleep flow reads the app singleton; route it to this test's store.
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => {
      if (!appStore.current) {
        throw new Error('no twin fixture store bound')
      }
      return appStore.current.getState()
    },
    subscribe: (listener: Parameters<HostTwinFixture['store']['subscribe']>[0]) =>
      appStore.current?.subscribe(listener) ?? (() => {})
  }
}))

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

const { sleepWorktreesReportingFailures } = await import('@/components/sidebar/sleep-worktree-flow')
const { fakeMainSleep } = await import('@/components/sidebar/sleep-worktree-test-main')

const ptyKill = vi.fn()

function answerLikeHost(args: RuntimeEnvironmentCallRequest): unknown {
  const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
  if (compatible) {
    return compatible
  }
  const result =
    args.method === 'terminal.sleep'
      ? {
          stopped: 1,
          stoppedPtyIds: [],
          livePtyIds: [],
          postStopVerified: true
        }
      : {}
  return {
    id: args.method,
    ok: true,
    result,
    _meta: { runtimeId: 'runtime-b' }
  }
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  ptyKill.mockReset()
  vi.stubGlobal('window', {
    api: {
      repos: { remove: vi.fn(), removeForHost: vi.fn() },
      folderWorkspaces: { delete: vi.fn().mockResolvedValue(true) },
      pty: { kill: ptyKill },
      gh: { enqueuePRRefresh: vi.fn().mockResolvedValue(undefined) },
      runtimeEnvironments: {
        call: vi.fn(answerLikeHost),
        list: vi.fn().mockResolvedValue([{ id: TWIN_RUNTIME_ENV }])
      },
      ui: { set: vi.fn().mockResolvedValue(undefined) },
      // Main runs the sleep; the window follows its notices as in the app.
      worktrees: { sleep: fakeMainSleep().sleep, sleepReopened: vi.fn() }
    }
  })
})

let current: HostTwinFixture | null = null

afterEach(() => {
  if (current) {
    resetHostTwinModuleStores(current)
  }
  current = null
  appStore.current = null
  vi.unstubAllGlobals()
})

type TwinAction = {
  id: string
  /** The entry point under test; review this table when one is added or moved. */
  source: string
  appliesTo: (kind: HostTwinKind) => boolean
  run: (fixture: HostTwinFixture, target: HostTwinSide) => Promise<unknown>
  /** Proves the action reached its target, so an isolated no-op can't pass. */
  applied: (fixture: HostTwinFixture, target: HostTwinSide) => void
  // Workspace-wide by design (user decision 2026-10-17): assert survivor was acted on too.
  wholeWorkspace?: (fixture: HostTwinFixture, survivor: HostTwinSide) => void
}

const survivorStopped = (f: HostTwinFixture, survivor: HostTwinSide) =>
  expect(f.store.getState().ptyIdsByTabId[survivor.terminalTabId] ?? []).toEqual([])

const isFolderKind = (kind: HostTwinKind) =>
  kind === 'folder local+ssh' || kind === 'folder group local+ssh'
const settle = async (run: () => unknown) => {
  try {
    await run()
  } catch {
    // A refusal is an acceptable outcome; the isolation assertion is what matters.
  }
}

const TWIN_ACTIONS: readonly TwinAction[] = [
  {
    id: 'remove project',
    source: 'store/repos/repo-removal.ts removeProject',
    appliesTo: (kind) => !isFolderKind(kind),
    run: (f, target) => f.store.getState().removeProject(f.projectId, { hostId: target.hostId }),
    applied: (f, target) =>
      expect(f.store.getState().repos.map((repo) => repo.executionHostId)).not.toContain(
        target.hostId
      )
  },
  {
    id: 'delete folder workspace',
    source: 'store/folder-workspaces/folder-workspace-mutations.ts deleteFolderWorkspace',
    // Why: one unstamped row can't be deleted on one host only; the no-host case is below.
    appliesTo: (kind) => kind === 'folder local+ssh',
    run: (f, target) =>
      f.store.getState().deleteFolderWorkspace(f.projectId, { executionHostId: target.hostId }),
    applied: (f, target) =>
      expect(
        (f.store.getState().folderWorkspaces ?? []).map((folder) => folder.executionHostId)
      ).not.toContain(target.hostId)
  },
  {
    id: 'purge terminal state',
    source: 'store/slices/worktrees.ts purgeWorktreeTerminalState',
    appliesTo: () => true,
    run: async (f, target) =>
      f.store
        .getState()
        .purgeWorktreeTerminalState([
          hostWorktreeTarget({ id: f.workspaceKey, hostId: target.hostId })
        ]),
    applied: (f, target) =>
      expect(f.store.getState().ptyIdsByTabId[target.terminalTabId]).toBeUndefined()
  },
  {
    id: 'kill terminals',
    source: 'store/terminals/terminal-shutdown.ts shutdownWorktreeTerminals',
    appliesTo: () => true,
    // Why raw id: a twin's copies share one workspace, so killing one kills both.
    run: (f) => settle(() => f.store.getState().shutdownWorktreeTerminals(f.workspaceKey)),
    applied: (f, target) =>
      expect(f.store.getState().ptyIdsByTabId[target.terminalTabId] ?? []).toEqual([]),
    wholeWorkspace: survivorStopped
  },
  {
    id: 'sleep',
    source: 'components/sidebar/sleep-worktree-flow.ts sleepWorktreesReportingFailures',
    appliesTo: () => true,
    run: (f) => settle(() => sleepWorktreesReportingFailures([f.workspaceKey])),
    applied: (f, target) =>
      expect(f.store.getState().ptyIdsByTabId[target.terminalTabId] ?? []).toEqual([]),
    wholeWorkspace: survivorStopped
  },
  {
    id: 'select',
    source: 'store/slices/worktrees.ts setActiveWorktree / setActiveFolderWorkspace',
    // Why: a single unstamped folder row has no SSH copy to select.
    appliesTo: (kind) => kind !== 'folder group local+ssh',
    run: async (f, target) =>
      isFolderKind(f.kind)
        ? f.store.getState().setActiveFolderWorkspace(f.projectId, target.hostId)
        : f.store.getState().setActiveWorktree(f.workspaceKey, target.hostId),
    applied: (f, target) =>
      expect(f.store.getState().activeWorkspaceExecutionHostId).toBe(target.hostId),
    // Why: opening either copy wakes the shared workspace marker for both.
    wholeWorkspace: (f) => expect(hasWorktreeSleepIntent(f.workspaceKey)).toBe(false)
  }
]

const TWIN_KINDS: readonly HostTwinKind[] = [
  'local+ssh',
  'local+runtime',
  'folder local+ssh',
  'folder group local+ssh'
]

/** `<action> | <kind> | <target>` → why the survivor is touched today (tracker Stage 1 worklist). */
const KNOWN_TWIN_LEAKS: Readonly<Record<string, string>> = Object.fromEntries([])

function cellId(action: TwinAction, kind: HostTwinKind, target: 'local' | 'remote'): string {
  return `${action.id} | ${kind} | ${target}`
}

describe('an action on one twin leaves the other twin alone', () => {
  for (const kind of TWIN_KINDS) {
    for (const action of TWIN_ACTIONS.filter((a) => a.appliesTo(kind))) {
      for (const targetName of ['remote', 'local'] as const) {
        const id = cellId(action, kind, targetName)
        const knownLeak = KNOWN_TWIN_LEAKS[id]
        const label = action.wholeWorkspace
          ? `${id} (whole workspace by design)`
          : knownLeak
            ? `${id} (known leak: ${knownLeak})`
            : id
        it(label, async () => {
          const fixture = createHostTwinFixture(kind)
          current = fixture
          appStore.current = fixture.store
          const target = fixture[targetName]
          const survivor = targetName === 'remote' ? fixture.local : fixture.remote
          const before = projectHostTwinState(fixture, survivor)

          await action.run(fixture, target)

          const after = projectHostTwinState(fixture, survivor)
          const changed = changedHostTwinState(before, after)
          action.applied(fixture, target)
          if (action.wholeWorkspace) {
            action.wholeWorkspace(fixture, survivor)
            return
          }
          if (knownLeak) {
            // Fixed? Delete this cell's KNOWN_TWIN_LEAKS entry.
            expect(changed).not.toEqual([])
            return
          }
          expect(changed).toEqual([])
          if (survivor.hostId === 'local') {
            expect(ptyKill).not.toHaveBeenCalledWith(survivor.ptyId)
          }
        })
      }
    }
  }
})

describe('a folder action that names no host', () => {
  for (const kind of ['folder local+ssh', 'folder group local+ssh'] as const) {
    it(`refuses to delete a ${kind} twin and touches neither host`, async () => {
      const fixture = createHostTwinFixture(kind)
      current = fixture
      appStore.current = fixture.store
      const before = [fixture.local, fixture.remote].map((s) => projectHostTwinState(fixture, s))

      await expect(fixture.store.getState().deleteFolderWorkspace(fixture.projectId)).resolves.toBe(
        false
      )

      expect(window.api.folderWorkspaces.delete).not.toHaveBeenCalled()
      const calls = vi.mocked(window.api.runtimeEnvironments.call).mock.calls
      expect(calls.map(([request]) => request.method)).not.toContain('folderWorkspace.delete')
      const after = [fixture.local, fixture.remote].map((s) => projectHostTwinState(fixture, s))
      expect(after.map((state, i) => changedHostTwinState(before[i], state))).toEqual([[], []])
    })
  }
})

describe('the twin fixture', () => {
  it('seeds two hosts under one workspace key', () => {
    const fixture = createHostTwinFixture('local+ssh')
    current = fixture
    const hosts: ExecutionHostId[] = [fixture.local.hostId, fixture.remote.hostId]
    expect(hosts).toEqual(['local', 'ssh:conn-b'])
    expect(fixture.store.getState().tabsByWorktree[fixture.workspaceKey]).toHaveLength(3)
  })
})
