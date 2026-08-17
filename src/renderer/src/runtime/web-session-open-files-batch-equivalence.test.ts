/* Why: the batched open-file path reconciles against a slot-keyed draft instead of
 * rebuilding the global array per snapshot. These seeded cases assert it stays
 * indistinguishable from repeated single-snapshot reconciliation. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { OpenFile } from '../store/slices/editor'
import { resetWebSessionFocusIntentForTests } from './web-session-focus-intent'
import { resetWebSessionCloseIntentForTests } from './web-session-close-intent'
import { resetWebSessionReorderIntentForTests } from './web-session-reorder-intent'
import { resetWebAgentSessionHandoffsForTests } from './web-agent-session-handoff'
import {
  applyWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshots,
  resetWebSessionTabsSnapshotFreshnessForTests,
  type WebSessionTabsSyncState
} from './web-session-tabs-sync'

vi.mock('../store', () => ({ useAppStore: { setState: vi.fn() } }))

const ENV = 'web-env-1'
const NOW = 1_700_000_000_000
const WORKTREES = ['repo::/w0', 'repo::/w1', 'repo::/w2', 'repo::/bystander']
const PATHS = ['/repo/a.ts', '/repo/b.ts', '/repo/c.ts', '/repo/d.ts']
const ENVS: (string | null | undefined)[] = [ENV, 'other-env', null, undefined]

/** Deterministic LCG so a failing case is reproducible from its seed. */
function makeRandom(seed: number): () => number {
  let value = seed >>> 0
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0
    return value / 0x100000000
  }
}

function resetModuleState(): void {
  resetWebSessionTabsSnapshotFreshnessForTests()
  resetWebSessionFocusIntentForTests()
  resetWebSessionCloseIntentForTests()
  resetWebSessionReorderIntentForTests()
  resetWebAgentSessionHandoffsForTests()
}

function baseState(overrides: Partial<WebSessionTabsSyncState>): WebSessionTabsSyncState {
  return {
    activeBrowserTabId: null,
    activeBrowserTabIdByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    activeGroupIdByWorktree: {},
    activeTabId: null,
    activeTabIdByWorktree: {},
    activeTabType: 'terminal',
    activeTabTypeByWorktree: {},
    activeWorktreeId: WORKTREES[0]!,
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    browserCertificateFailuresByPageId: {},
    browserPagesByWorkspace: {},
    browserTabsByWorktree: {},
    groupsByWorktree: {},
    layoutByWorktree: {},
    openFiles: [],
    ptyIdsByTabId: {},
    remoteBrowserPageHandlesByPageId: {},
    tabBarOrderByWorktree: {},
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    unifiedTabsByWorktree: {},
    unreadTerminalTabs: {},
    sortEpoch: 0,
    ...overrides
  }
}

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!
}

function makeCase(seed: number): {
  state: WebSessionTabsSyncState
  snapshots: RuntimeMobileSessionTabsResult[]
} {
  const random = makeRandom(seed)
  const openFiles: OpenFile[] = []
  const fileCount = Math.floor(random() * 9)
  for (let i = 0; i < fileCount; i += 1) {
    const path = pick(random, PATHS)
    const isPreview = random() < 0.2
    openFiles.push({
      id: isPreview ? `markdown-preview::${path}` : path,
      filePath: path,
      relativePath: path.slice('/repo/'.length),
      worktreeId: pick(random, WORKTREES),
      language: 'typescript',
      isDirty: random() < 0.5,
      runtimeEnvironmentId: pick(random, ENVS),
      mode: isPreview ? 'markdown-preview' : 'edit',
      mirroredFromRuntimeSession: random() < 0.7,
      // Why: the mirrored file overwrites every compared field, so only a preserved
      // field like this can reveal which duplicate seeded it.
      lastKnownDiskSignature: `sig-${seed}-${i}`
    } as OpenFile)
  }

  const snapshots: RuntimeMobileSessionTabsResult[] = []
  const snapshotCount = 1 + Math.floor(random() * 7)
  for (let s = 0; s < snapshotCount; s += 1) {
    const worktree = pick(random, WORKTREES)
    const tabs: RuntimeMobileSessionTabsResult['tabs'] = []
    const editorCount = Math.floor(random() * 4)
    const usedPaths = new Set<string>()
    for (let e = 0; e < editorCount; e += 1) {
      const path = pick(random, PATHS)
      if (usedPaths.has(path)) {
        continue
      }
      usedPaths.add(path)
      const relativePath = path.slice('/repo/'.length)
      tabs.push(
        random() < 0.25
          ? ({
              type: 'markdown',
              id: `host-md-${s}-${e}`,
              title: relativePath,
              filePath: path,
              relativePath,
              language: 'markdown',
              mode: 'markdown-preview',
              isDirty: false,
              isActive: e === 0,
              sourceFileId: path,
              sourceFilePath: path,
              sourceRelativePath: relativePath,
              documentVersion: `file:${path}`
            } as RuntimeMobileSessionTabsResult['tabs'][number])
          : ({
              type: 'file',
              id: `host-file-${s}-${e}`,
              title: relativePath,
              filePath: path,
              relativePath,
              language: 'typescript',
              isDirty: random() < 0.5,
              isActive: e === 0
            } as RuntimeMobileSessionTabsResult['tabs'][number])
      )
    }
    const activeTab = tabs[0]
    snapshots.push({
      worktree,
      publicationEpoch: 'epoch-1',
      snapshotVersion: s + 1,
      activeGroupId: `host-group-${worktree}`,
      activeTabId: activeTab?.id ?? null,
      activeTabType: activeTab ? (activeTab.type === 'markdown' ? 'markdown' : 'file') : null,
      tabs
    })
  }

  const activeFile = openFiles[Math.floor(random() * Math.max(openFiles.length, 1))]
  return {
    state: baseState({
      openFiles,
      activeFileId: activeFile?.id ?? null,
      activeFileIdByWorktree: activeFile ? { [activeFile.worktreeId]: activeFile.id } : {},
      activeTabTypeByWorktree: activeFile ? { [activeFile.worktreeId]: 'editor' } : {},
      activeWorktreeId: pick(random, WORKTREES)
    }),
    snapshots
  }
}

describe('batched open-file reconciliation', () => {
  beforeEach(() => {
    resetModuleState()
  })

  it('matches repeated single-snapshot reconciliation for every seeded case', () => {
    const divergences: string[] = []
    for (let seed = 1; seed <= 400; seed += 1) {
      const { state, snapshots } = makeCase(seed)
      const stateCopy = structuredClone(state)

      resetModuleState()
      let sequential = state
      for (const snapshot of snapshots) {
        const patch = applyWebSessionTabsSnapshot(sequential, snapshot, ENV, NOW)
        if (patch !== sequential) {
          sequential = { ...sequential, ...patch }
        }
      }

      resetModuleState()
      const batched = {
        ...state,
        ...applyWebSessionTabsSnapshots(state, snapshots, ENV, NOW)
      }

      try {
        expect(batched.openFiles).toEqual(sequential.openFiles)
        expect(batched.activeFileId).toEqual(sequential.activeFileId)
        expect(batched.activeFileIdByWorktree).toEqual(sequential.activeFileIdByWorktree)
        expect(batched.activeTabTypeByWorktree).toEqual(sequential.activeTabTypeByWorktree)
        expect(batched.unifiedTabsByWorktree).toEqual(sequential.unifiedTabsByWorktree)
        expect(state).toEqual(stateCopy)
      } catch (error) {
        divergences.push(
          `seed ${seed}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`
        )
      }
    }
    expect(divergences).toEqual([])
  })
})
