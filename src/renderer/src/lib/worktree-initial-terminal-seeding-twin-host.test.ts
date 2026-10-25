// A create on a paired server whose repo and path also exist on another host (a "twin"): seeding
// resolves the owner by the host the create went to, so the desktop lays out no second set of the
// server's default tabs (ledger L277).
import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type * as WebRuntimeSessionModule from '@/runtime/web-runtime-session-environment'
import type { Repo } from '../../../shared/repo-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { createTestStore, makeWorktree } from '@/store/slices/store-test-helpers'
import { ensureWorktreeHasInitialTerminal } from '@/lib/worktree-initial-terminal-seeding'
import { applyCreatedWorktree } from '@/store/slices/worktrees/create/created-worktree-state-merge'

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})
vi.mock('@/runtime/web-runtime-session-environment', async (importOriginal) => ({
  ...(await importOriginal<typeof WebRuntimeSessionModule>()),
  // The paired server's session is up.
  isWebRuntimeSessionActive: (environmentId: string | null | undefined) => environmentId === 'env-1'
}))

const SERVER: ExecutionHostId = 'runtime:env-1'
const REPO_ID = 'repoP'
const PATH = '/srv/proj/new-ws'
const WT = `${REPO_ID}::${PATH}`
const defaultTabs = {
  tabs: [
    { title: 'A', command: 'echo a' },
    { title: 'B', command: 'echo b' }
  ],
  runCommands: true
}
const issueCommand = { command: 'echo issue' }
const setup = { runnerScriptPath: `${PATH}/.orca/setup.sh`, envVars: {} }

function repo(executionHostId?: ExecutionHostId): Repo {
  return {
    id: REPO_ID,
    path: '/srv/proj',
    displayName: 'p',
    badgeColor: '#000',
    addedAt: 0,
    ...(executionHostId ? { executionHostId } : {})
  }
}

/** The server's create result merged the real way, then the background create's seeding. */
function createOnServer(opts: { twin: boolean; passHost: boolean }) {
  const store = createTestStore()
  store.setState({
    repos: opts.twin ? [repo(), repo(SERVER)] : [repo(SERVER)],
    worktreesByRepo: opts.twin
      ? { [REPO_ID]: [makeWorktree({ id: WT, repoId: REPO_ID, path: PATH, hostId: 'local' })] }
      : {}
  })
  applyCreatedWorktree(
    store.setState,
    REPO_ID,
    { worktree: makeWorktree({ id: WT, repoId: REPO_ID, path: PATH }), defaultTabs },
    SERVER
  )
  ensureWorktreeHasInitialTerminal(
    store.getState(),
    WT,
    undefined,
    setup,
    issueCommand,
    defaultTabs,
    { activateCreatedTabs: false, ...(opts.passHost ? { executionHostId: SERVER } : {}) }
  )
  return store.getState().tabsByWorktree[WT] ?? []
}

describe('seeding a workspace a paired server created', () => {
  it('lays out no tabs of its own for a twin, given the host the create went to', () => {
    expect(createOnServer({ twin: true, passHost: true })).toEqual([])
  })

  it('lays out no tabs of its own for a workspace only the server lists, as before', () => {
    expect(createOnServer({ twin: false, passHost: false })).toEqual([])
    expect(createOnServer({ twin: false, passHost: true })).toEqual([])
  })
})
