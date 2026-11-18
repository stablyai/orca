// @vitest-environment happy-dom

import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, vi, type Mock } from 'vitest'

const mocks: { getRuntimeGitHistory: Mock } = vi.hoisted(() => ({ getRuntimeGitHistory: vi.fn() }))

export { mocks }

vi.mock('@/runtime/source-control/git/runtime-git-status-client', () => ({
  getRuntimeGitHistory: mocks.getRuntimeGitHistory
}))
vi.mock('@/lib/workspace/ownership/connection-context', () => ({
  getConnectionId: () => undefined
}))

import { useSourceControlGitHistory } from './use-git-history'
import { mountProbe, unmountProbes } from '../panel/source-control-hook-test-harness'
import type { GitHistoryResult } from '../../../../../../shared/git/history/git-history-types'

export function historyResult(subject: string, headOid?: string): GitHistoryResult {
  return {
    items: [{ id: subject, parentIds: [], subject, message: subject }],
    ...(headOid ? { currentRef: { id: 'refs/heads/main', name: 'main', revision: headOid } } : {}),
    hasIncomingChanges: false,
    hasOutgoingChanges: false,
    hasMore: false,
    limit: 50
  }
}

export const ALL_WORKTREES = new Map<string, unknown>([
  ['A', {}],
  ['B', {}]
])

type Api = ReturnType<typeof useSourceControlGitHistory>

export const historyProbe: { current: Api | null } = { current: null }

export function Probe(props: {
  activeRepoTarget?: RuntimeClientTarget
  worktreeId?: string | null
  worktreePath?: string
  branchName?: string
  compareBaseRef?: string | null
  compareBaseOid?: string | null
  isFolder?: boolean
  isBranchVisible?: boolean
  headOid?: string | null
  headUnknown?: boolean
  isGitHistoryNeeded?: boolean
  isGitHistoryVisible?: boolean
  worktreeMap?: ReadonlyMap<string, unknown>
}): null {
  historyProbe.current = useSourceControlGitHistory({
    activeRepoTarget: props.activeRepoTarget ?? { kind: 'local' },
    activeWorktreeId: props.worktreeId === undefined ? 'A' : props.worktreeId,
    worktreePath: props.worktreePath ?? '/a',
    branchName: props.branchName ?? 'main',
    compareBaseRef: props.compareBaseRef === undefined ? 'origin/main' : props.compareBaseRef,
    compareBaseOid: props.compareBaseOid ?? null,
    headOid: props.headUnknown ? undefined : (props.headOid ?? null),
    isFolder: props.isFolder ?? false,
    isBranchVisible: props.isBranchVisible ?? true,
    isGitHistoryNeeded: props.isGitHistoryNeeded ?? true,
    isGitHistoryVisible: props.isGitHistoryVisible ?? true,
    worktreeMap: props.worktreeMap ?? ALL_WORKTREES
  })
  return null
}

export async function mount(props: Parameters<typeof Probe>[0] = {}): Promise<Root> {
  return mountProbe(<Probe {...props} />)
}

beforeEach(() => {
  mocks.getRuntimeGitHistory.mockResolvedValue(historyResult('default'))
})

afterEach(async () => {
  // History is a session cache; an empty worktree map prunes it between tests.
  await mount({ worktreeId: null, worktreeMap: new Map() })
  unmountProbes()
  vi.clearAllMocks()
  historyProbe.current = null
})
