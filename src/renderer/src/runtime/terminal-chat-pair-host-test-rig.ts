import { vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { RuntimeSessionTabPropsResult } from '../../../shared/runtime-session-contracts'
import type { TerminalPaneLayoutNode } from '../../../shared/terminal-tab-types'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { useAppStore } from '@/store'
import {
  applyWebSessionTabsSnapshot,
  applyWebSessionTabsStorePatch,
  decideWebSessionTabsSnapshot,
  resetWebSessionTabsSnapshotFreshnessForTests
} from './web-session-tabs-sync'
import { resetChatPairOutboundForTests } from './terminal-chat-pair-outbound'
import { resolveEffectiveChatPair } from '@/store/slices/tabs/terminal-chat-pair-effective'
import { makeRuntimeOwnedWorktree } from '@/store/slices/store-test-helpers'

export const ENV = 'web-env-1'
export const WT = 'repo::/worktree'
export const PARENT = 'host-tab-1'
export const A = '11111111-1111-4111-8111-111111111111'
export const B = '22222222-2222-4222-8222-222222222222'
export const C = '33333333-3333-4333-8333-333333333333'
export const TERMINAL_TAB_ID = toWebTerminalSurfaceTabId(PARENT)
const NOW = 1_700_000_000_000
const initialState = useAppStore.getInitialState()

export type HostPairSnapshot = {
  marker?: boolean
  viewMode?: 'terminal' | 'chat'
  owner?: string
  leaves?: string[]
}

function splitRoot(leaves: string[]): TerminalPaneLayoutNode {
  const [first, ...rest] = leaves
  const leaf: TerminalPaneLayoutNode = { type: 'leaf', leafId: first! }
  return rest.length === 0
    ? leaf
    : { type: 'split', direction: 'vertical', first: leaf, second: splitRoot(rest) }
}

let snapshotVersion = 0

export function makeHostPairSnapshot(pair: HostPairSnapshot = {}): RuntimeMobileSessionTabsResult {
  const leaves = pair.leaves ?? [A, B]
  snapshotVersion += 1
  return {
    worktree: WT,
    publicationEpoch: 'epoch-1',
    snapshotVersion,
    activeGroupId: 'host-group-1',
    activeTabId: `${PARENT}::${leaves[0]}`,
    activeTabType: 'terminal',
    ...(pair.marker === false ? {} : { chatViewHostOwned: true as const }),
    tabs: leaves.map((leafId, index) => ({
      type: 'terminal' as const,
      id: `${PARENT}::${leafId}`,
      title: 'codex',
      parentTabId: PARENT,
      leafId,
      isActive: index === 0,
      launchAgent: 'codex' as const,
      status: 'ready' as const,
      terminal: `terminal-${index + 1}`,
      ...(pair.viewMode ? { viewMode: pair.viewMode } : {}),
      parentLayout: {
        root: splitRoot(leaves),
        activeLeafId: leaves[0]!,
        expandedLeafId: null,
        ...(pair.owner ? { chatLeafId: pair.owner } : {})
      }
    }))
  }
}

/** Applies a host frame through the same store funnel every live subscription uses. */
export function applyHostSnapshot(snapshot: RuntimeMobileSessionTabsResult): void {
  const decision = decideWebSessionTabsSnapshot(snapshot, ENV)
  applyWebSessionTabsStorePatch((state) => applyWebSessionTabsSnapshot(state, snapshot, ENV, NOW), {
    frames: [{ environmentId: ENV, worktreeId: snapshot.worktree, decision }]
  })
}

export function effectivePair() {
  return resolveEffectiveChatPair(useAppStore.getState(), WT, TERMINAL_TAB_ID)
}

export function storedPair() {
  const state = useAppStore.getState()
  return {
    row: state.tabsByWorktree[WT]?.find((tab) => tab.id === TERMINAL_TAB_ID)?.viewMode,
    unified: state.unifiedTabsByWorktree[WT]?.find((tab) => tab.entityId === TERMINAL_TAB_ID)
      ?.viewMode,
    owner: state.terminalLayoutsByTabId[TERMINAL_TAB_ID]?.chatLeafId
  }
}

export type FakeHostCall = {
  method: string
  params: Record<string, unknown>
  resolve: (result: RuntimeSessionTabPropsResult) => void
  reject: (code: string) => void
}

/** Records every runtime call; pair writes stay pending until the test answers them. */
export function installFakeHost() {
  const calls: FakeHostCall[] = []
  const call = vi.fn(
    (args: { method: string; params?: unknown }) =>
      new Promise((resolve) => {
        calls.push({
          method: args.method,
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every caller in these tests sends an object of params.
          params: (args.params ?? {}) as Record<string, unknown>,
          resolve: (result) => resolve({ id: args.method, ok: true, result, _meta: {} }),
          reject: (code) =>
            resolve({ id: args.method, ok: false, error: { code, message: code }, _meta: {} })
        })
        if (args.method !== 'session.tabs.setTabProps') {
          resolve({ id: args.method, ok: true, result: { updated: true }, _meta: {} })
        }
      })
  )
  // Why a partial stub: these tests reach only runtime calls and the two UI writes below.
  vi.stubGlobal('api', {
    runtimeEnvironments: { call },
    ui: { set: vi.fn() },
    pty: { clearBuffer: vi.fn() }
  })
  return {
    call,
    calls,
    pairWrites: () => calls.filter((entry) => entry.method === 'session.tabs.setTabProps'),
    layoutPushes: () => calls.filter((entry) => entry.method === 'session.tabs.updatePaneLayout')
  }
}

/** A worktree owned by a paired runtime, with this desktop's Chat UI on. */
export function resetPairedStore(): void {
  resetWebSessionTabsSnapshotFreshnessForTests()
  resetChatPairOutboundForTests()
  snapshotVersion = 0
  useAppStore.setState(initialState, true)
  useAppStore.setState({
    settings: {
      ...useAppStore.getState().settings!,
      activeRuntimeEnvironmentId: ENV,
      experimentalNativeChat: true
    },
    worktreesByRepo: { repo: [makeRuntimeOwnedWorktree({ id: WT, repoId: 'repo' }, ENV)] }
  })
}

/** Lets dynamic imports and RPC promise chains settle. */
export async function flushAsync(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve()
  }
  await new Promise((resolve) => setTimeout(resolve, 0))
}
