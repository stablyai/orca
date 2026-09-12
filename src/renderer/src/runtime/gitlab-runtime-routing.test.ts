import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeRpcClientModule from './runtime-rpc-client'
import { LOCAL_EXECUTION_HOST_ID, toRuntimeExecutionHostId } from '../../../shared/execution-host'
import {
  normalizeTaskSourceContext,
  type TaskSourceContext
} from '../../../shared/task-source-context'

// vi.hoisted so the spy exists before the hoisted vi.mock factory runs.
const { callRuntimeRpc } = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(async () => ({ items: [] }))
}))
vi.mock('./runtime-rpc-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeRpcClientModule>()
  return { ...actual, callRuntimeRpc }
})

const gl = {
  listIssues: vi.fn(async () => ({ items: [] })),
  listMRs: vi.fn(async () => ({ items: [] })),
  todos: vi.fn(async () => []),
  workItemDetails: vi.fn(async () => null),
  listLabels: vi.fn(async () => []),
  listAssignableUsers: vi.fn(async () => [{ username: 'matthew' }]),
  updateMR: vi.fn(async () => ({ ok: true })),
  jobTrace: vi.fn(async () => ({ ok: true })),
  retryJob: vi.fn(async () => ({ ok: true })),
  updateMRReviewers: vi.fn(async () => ({})),
  addMRInlineComment: vi.fn(async () => ({})),
  closeMR: vi.fn(async () => ({ ok: true })),
  reopenMR: vi.fn(async () => ({ ok: true })),
  mergeMR: vi.fn(async () => ({ ok: true })),
  addMRComment: vi.fn(async () => ({})),
  addIssueComment: vi.fn(async () => ({})),
  resolveMRDiscussion: vi.fn(async () => ({}))
}
// @ts-expect-error -- minimal window.api stub for the module under test
globalThis.window = { api: { gl } }

import { getGitLabTaskRuntimeTarget, routedGitLab } from './gitlab-runtime-routing'

const ENV = { kind: 'environment' as const, environmentId: 'macbook-pro' }

function gitlabContext(hostId: string, repoId: string | null = 'repo-1'): TaskSourceContext {
  const context = normalizeTaskSourceContext({
    provider: 'gitlab',
    projectId: 'project-1',
    hostId,
    repoId
  })
  if (!context) {
    throw new Error('failed to build test source context')
  }
  return context
}

const RUNTIME_HOST = toRuntimeExecutionHostId('macbook-pro')

beforeEach(() => {
  callRuntimeRpc.mockClear()
  for (const fn of Object.values(gl)) {
    fn.mockClear()
  }
})

describe('getGitLabTaskRuntimeTarget', () => {
  it('routes local for a repo owned by the local host', () => {
    expect(
      getGitLabTaskRuntimeTarget({
        repoId: 'repo-1',
        sourceContext: gitlabContext(LOCAL_EXECUTION_HOST_ID)
      })
    ).toEqual({ kind: 'local' })
  })

  it('routes to the owning runtime environment with an id selector', () => {
    expect(
      getGitLabTaskRuntimeTarget({ repoId: 'repo-1', sourceContext: gitlabContext(RUNTIME_HOST) })
    ).toEqual({ kind: 'environment', environmentId: 'macbook-pro', repoSelector: 'id:repo-1' })
  })

  it('prefers the source context repo id over the args repo id', () => {
    expect(
      getGitLabTaskRuntimeTarget({
        repoId: 'renderer-id',
        sourceContext: gitlabContext(RUNTIME_HOST, 'host-id')
      })
    ).toEqual({ kind: 'environment', environmentId: 'macbook-pro', repoSelector: 'id:host-id' })
  })

  it('routes local when a runtime repo has no resolvable id', () => {
    expect(
      getGitLabTaskRuntimeTarget({ sourceContext: gitlabContext(RUNTIME_HOST, null) })
    ).toEqual({ kind: 'local' })
  })

  it('routes local without a source context', () => {
    expect(getGitLabTaskRuntimeTarget({ repoId: 'repo-1' })).toEqual({ kind: 'local' })
  })

  it('routes local for a non-gitlab source context', () => {
    const github = {
      kind: 'task-source' as const,
      provider: 'github' as const,
      projectId: 'project-1',
      hostId: RUNTIME_HOST,
      repoId: 'repo-1'
    }
    expect(getGitLabTaskRuntimeTarget({ repoId: 'repo-1', sourceContext: github })).toEqual({
      kind: 'local'
    })
  })
})

describe('routedGitLab local vs remote transport', () => {
  it('hits local IPC for a local repo', async () => {
    await routedGitLab.workItemDetails({
      repoPath: '/repo',
      repoId: 'repo-1',
      sourceContext: gitlabContext(LOCAL_EXECUTION_HOST_ID),
      iid: 2,
      type: 'issue'
    })
    expect(callRuntimeRpc).not.toHaveBeenCalled()
    expect(gl.workItemDetails).toHaveBeenCalledWith(
      expect.objectContaining({ repoPath: '/repo', repoId: 'repo-1', iid: 2, type: 'issue' })
    )
  })

  it('bounds the local IPC branch with a timeout so a hung glab call cannot spin forever', async () => {
    vi.useFakeTimers()
    try {
      gl.workItemDetails.mockImplementationOnce(() => new Promise<never>(() => {}))
      const pending = routedGitLab.workItemDetails({
        repoPath: '/repo',
        repoId: 'repo-1',
        sourceContext: gitlabContext(LOCAL_EXECUTION_HOST_ID),
        iid: 2,
        type: 'issue'
      })
      const assertion = expect(pending).rejects.toThrow(/timed out/i)
      await vi.advanceTimersByTimeAsync(30_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('relays workItemDetails to the runtime host with an id selector', async () => {
    await routedGitLab.workItemDetails({
      repoPath: '/repo',
      repoId: 'repo-1',
      sourceContext: gitlabContext(RUNTIME_HOST),
      iid: 2,
      type: 'issue'
    })
    expect(gl.workItemDetails).not.toHaveBeenCalled()
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      ENV,
      'gitlab.workItemDetails',
      { repo: 'id:repo-1', iid: 2, type: 'issue' },
      { timeoutMs: 30_000 }
    )
  })

  it('relays list fetches to the runtime host', async () => {
    await routedGitLab.listIssues({
      repoPath: '/repo',
      repoId: 'repo-1',
      sourceContext: gitlabContext(RUNTIME_HOST),
      state: 'opened',
      limit: 50
    })
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      ENV,
      'gitlab.listIssues',
      { repo: 'id:repo-1', state: 'opened', limit: 50 },
      { timeoutMs: 30_000 }
    )
  })

  it('maps closeMR to updateMRState with the closed state', async () => {
    await routedGitLab.closeMR({
      repoPath: '/repo',
      repoId: 'repo-1',
      sourceContext: gitlabContext(RUNTIME_HOST),
      iid: 5
    })
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      ENV,
      'gitlab.updateMRState',
      { repo: 'id:repo-1', iid: 5, state: 'closed' },
      { timeoutMs: 30_000 }
    )
  })

  it('maps reopenMR to updateMRState with the opened state', async () => {
    await routedGitLab.reopenMR({
      repoPath: '/repo',
      repoId: 'repo-1',
      sourceContext: gitlabContext(RUNTIME_HOST),
      iid: 5
    })
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      ENV,
      'gitlab.updateMRState',
      { repo: 'id:repo-1', iid: 5, state: 'opened' },
      { timeoutMs: 30_000 }
    )
  })

  it('returns an empty assignable-user list for a remote repo without an RPC', async () => {
    const result = await routedGitLab.listAssignableUsers({
      repoPath: '/repo',
      repoId: 'repo-1',
      sourceContext: gitlabContext(RUNTIME_HOST)
    })
    expect(result).toEqual([])
    expect(callRuntimeRpc).not.toHaveBeenCalled()
    expect(gl.listAssignableUsers).not.toHaveBeenCalled()
  })

  it('still fetches assignable users locally for a local repo', async () => {
    await routedGitLab.listAssignableUsers({
      repoPath: '/repo',
      repoId: 'repo-1',
      sourceContext: gitlabContext(LOCAL_EXECUTION_HOST_ID)
    })
    expect(gl.listAssignableUsers).toHaveBeenCalled()
  })
})

// Why: locks every routed method's RPC name and arg passthrough so a copy-paste
// miswire (e.g. mergeMR -> gitlab.updateMR) can't stay green — the method name is
// a plain string type-checking can't validate. Also pins the remote-only extras
// (close/reopen state, jobTrace logExcerpt).
describe('routedGitLab remote method-name and arg wiring', () => {
  const CASES: readonly {
    method: keyof typeof routedGitLab
    rpc: string
    args: Record<string, unknown>
    expected: Record<string, unknown>
  }[] = [
    {
      method: 'listIssues',
      rpc: 'gitlab.listIssues',
      args: { state: 'opened', limit: 50 },
      expected: { state: 'opened', limit: 50 }
    },
    {
      method: 'listMRs',
      rpc: 'gitlab.listMRs',
      args: { state: 'opened', page: 1, perPage: 50 },
      expected: { state: 'opened', page: 1, perPage: 50 }
    },
    { method: 'todos', rpc: 'gitlab.todos', args: {}, expected: {} },
    {
      method: 'workItemDetails',
      rpc: 'gitlab.workItemDetails',
      args: { iid: 2, type: 'issue' },
      expected: { iid: 2, type: 'issue' }
    },
    { method: 'listLabels', rpc: 'gitlab.listLabels', args: {}, expected: {} },
    {
      method: 'updateMR',
      rpc: 'gitlab.updateMR',
      args: { iid: 5, updates: { title: 'x' } },
      expected: { iid: 5, updates: { title: 'x' } }
    },
    {
      method: 'jobTrace',
      rpc: 'gitlab.jobTrace',
      args: { jobId: 9, projectRef: null },
      expected: { jobId: 9, projectRef: null, logExcerpt: true }
    },
    {
      method: 'retryJob',
      rpc: 'gitlab.retryJob',
      args: { jobId: 9, projectRef: null },
      expected: { jobId: 9, projectRef: null }
    },
    {
      method: 'updateMRReviewers',
      rpc: 'gitlab.updateMRReviewers',
      args: { iid: 5, reviewerIds: [1], projectRef: null },
      expected: { iid: 5, reviewerIds: [1], projectRef: null }
    },
    {
      method: 'addMRInlineComment',
      rpc: 'gitlab.addMRInlineComment',
      args: { iid: 5, input: { body: 'x' }, projectRef: null },
      expected: { iid: 5, input: { body: 'x' }, projectRef: null }
    },
    {
      method: 'closeMR',
      rpc: 'gitlab.updateMRState',
      args: { iid: 5 },
      expected: { iid: 5, state: 'closed' }
    },
    {
      method: 'reopenMR',
      rpc: 'gitlab.updateMRState',
      args: { iid: 5 },
      expected: { iid: 5, state: 'opened' }
    },
    {
      method: 'mergeMR',
      rpc: 'gitlab.mergeMR',
      args: { iid: 5, method: 'merge' },
      expected: { iid: 5, method: 'merge' }
    },
    {
      method: 'addMRComment',
      rpc: 'gitlab.addMRComment',
      args: { iid: 5, body: 'hi' },
      expected: { iid: 5, body: 'hi' }
    },
    {
      method: 'addIssueComment',
      rpc: 'gitlab.addIssueComment',
      args: { number: 2, body: 'hi' },
      expected: { number: 2, body: 'hi' }
    },
    {
      method: 'resolveMRDiscussion',
      rpc: 'gitlab.resolveMRDiscussion',
      args: { iid: 5, discussionId: 'd1', resolved: true },
      expected: { iid: 5, discussionId: 'd1', resolved: true }
    }
  ]

  for (const { method, rpc, args, expected } of CASES) {
    it(`relays ${method} to ${rpc} with the selector and stripped fields`, async () => {
      const call = routedGitLab[method] as (a: Record<string, unknown>) => Promise<unknown>
      await call({
        repoPath: '/repo',
        repoId: 'repo-1',
        sourceContext: gitlabContext(RUNTIME_HOST),
        ...args
      })
      expect(callRuntimeRpc).toHaveBeenCalledWith(
        ENV,
        rpc,
        { repo: 'id:repo-1', ...expected },
        { timeoutMs: 30_000 }
      )
    })
  }
})
