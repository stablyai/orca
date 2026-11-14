import '../../src/main/runtime/rpc/dispatch/testing/unused-default-rpc-methods.test-fixture'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearTimeout as clearRealTimeout, setTimeout as setRealTimeout } from 'node:timers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RuntimeClient } from '../../src/cli/runtime/client'
import * as mutations from '../../src/main/linear/issues/linear-issue-mutations'
import * as comments from '../../src/main/linear/issues/linear-issue-comments'
import * as relations from '../../src/main/linear/issues/issue-relation-write'
import { LinearWriteFailure } from '../../src/main/linear/issues/linear-issue-write-support'
import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../../src/main/runtime/rpc/server/runtime-rpc'
import { LINEAR_AGENT_ACCESS_METHODS } from '../../src/main/runtime/rpc/methods/integrations/linear/linear-agent-access'

const writeId = '11111111-1111-4111-8111-111111111111'
const issue = {
  id: 'issue-1',
  identifier: 'ENG-1',
  title: 'Title',
  description: '',
  url: 'https://linear.app/acme/issue/ENG-1',
  team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
  state: { id: 'todo', name: 'Todo' },
  parent: null,
  project: null,
  assignee: null,
  priority: 0,
  estimate: null,
  dueDate: null,
  labelIds: [],
  labels: []
}
const target = { issue, workspaceId: 'w1' }
const comment = {
  id: writeId,
  url: null,
  body: 'old',
  issue,
  parentId: null,
  threadRootId: writeId
}
let runtime: OrcaRuntimeService
let server: OrcaRuntimeRpcServer
let userDataPath: string
let failure: LinearWriteFailure

async function observe<T>(pending: Promise<T>, phase: string): Promise<T> {
  let timer: ReturnType<typeof setRealTimeout> | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setRealTimeout(() => reject(new Error(`Timed out observing ${phase}`)), 2_000)
      })
    ])
  } finally {
    clearRealTimeout(timer)
  }
}

beforeEach(async () => {
  userDataPath = mkdtempSync(join(tmpdir(), 'linear-write-cli-'))
  vi.stubEnv('ORCA_USER_DATA_PATH', userDataPath)
  for (const name of [
    'ORCA_PAIRING_CODE',
    'ORCA_REMOTE_PAIRING',
    'ORCA_ENVIRONMENT',
    'ORCA_WORKTREE_ID',
    'ORCA_TERMINAL_HANDLE',
    'ORCA_RUNTIME_SOURCE_ID'
  ]) {
    vi.stubEnv(name, '')
  }
  process.exitCode = 0
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  runtime = new OrcaRuntimeService()
  vi.spyOn(runtime, 'resolveLinearAgentWriteTarget').mockImplementation(async (params) =>
    params.input === 'ENG-2'
      ? { ...target, issue: { ...issue, id: 'issue-2', identifier: 'ENG-2' } }
      : target
  )
  vi.spyOn(runtime, 'resolveLinearCreateTeam').mockResolvedValue({
    ...issue.team,
    workspaceId: 'w1'
  })
  vi.spyOn(runtime, 'getLinearTeamStatesForWrite').mockResolvedValue([
    { id: 'done', name: 'Done', type: 'completed', color: '#888888', position: 1 }
  ])
  vi.spyOn(runtime, 'readLinearAgentIssueWriteRecord').mockResolvedValue(issue)
  vi.spyOn(runtime, 'getLinearTeamLabelsForWrite').mockResolvedValue([
    { id: 'bug', name: 'Bug', color: '#888888' }
  ])
  vi.spyOn(runtime, 'getLinearViewerForWrite').mockResolvedValue({ id: 'user-1' })
  vi.spyOn(runtime, 'resolveLinearAgentComment').mockResolvedValue({ comment, workspaceId: 'w1' })
  vi.spyOn(runtime, 'getMatchingLinearCommentWrite').mockResolvedValue(null)
  vi.spyOn(runtime, 'getMatchingLinearAttachmentWrite').mockResolvedValue(null)
  vi.spyOn(runtime, 'getMatchingLinearCreatedIssue').mockResolvedValue(null)
  vi.spyOn(runtime, 'notifyLinearLinkedIssueUpdated').mockReturnValue(undefined)
  failure = new LinearWriteFailure('unconfirmed', 'Confirmation lost')
  const lost = () => {
    throw failure
  }
  vi.spyOn(mutations, 'updateIssueForAgent').mockImplementation(
    async (_id, _fields, _workspace, options) => {
      options?.beforeInvoke?.()
      return lost()
    }
  )
  vi.spyOn(mutations, 'createIssueForAgent').mockImplementation(
    async (_team, _title, _body, _workspace, options) => {
      options.beforeInvoke?.()
      return lost()
    }
  )
  vi.spyOn(comments, 'addIssueCommentForAgent').mockImplementation(
    async (_id, _body, _workspace, options) => {
      options.beforeInvoke?.()
      return lost()
    }
  )
  vi.spyOn(comments, 'createIssueAttachment').mockImplementation(
    async (_id, _input, _workspace, options) => {
      options?.beforeInvoke?.()
      return lost()
    }
  )
  vi.spyOn(comments, 'updateIssueCommentForAgent').mockImplementation(
    async (_id, _body, _workspace, options) => {
      options?.beforeInvoke?.()
      return lost()
    }
  )
  vi.spyOn(comments, 'deleteIssueCommentForAgent').mockImplementation(
    async (_id, _workspace, options) => {
      options?.beforeInvoke?.()
      return lost()
    }
  )
  vi.spyOn(relations, 'writeIssueRelation').mockImplementation(async (params) => {
    params.beforeInvoke?.()
    return lost()
  })
  server = new OrcaRuntimeRpcServer({ runtime, userDataPath, methods: LINEAR_AGENT_ACCESS_METHODS })
  await server.start()
})

afterEach(async () => {
  vi.useRealTimers()
  await server.stop()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  process.exitCode = 0
  rmSync(userDataPath, { recursive: true, force: true })
})

it('propagates real client socket timeout into preparation cancellation', async () => {
  let release = () => {}
  let entered = () => {}
  let cancelled = () => {}
  const held = new Promise<typeof target>((resolve) => {
    release = () => resolve(target)
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const aborted = new Promise<void>((resolve) => {
    cancelled = resolve
  })
  vi.mocked(runtime.resolveLinearAgentWriteTarget).mockImplementation((_params, signal) => {
    signal?.addEventListener('abort', () => cancelled(), { once: true })
    entered()
    return held
  })
  const dispatch = vi.spyOn(runtime, 'linearIssueSetState')
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const client = new RuntimeClient(userDataPath, 30, null, null)
  const pending = client.call('linear.issueSetState', { input: 'ENG-1', to: 'Done' }).then(
    (value) => ({ value }),
    (error) => ({ error })
  )
  try {
    await observe(started, 'preparation admission before client timeout')
    expect(mutations.updateIssueForAgent).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(30)
    expect(await observe(pending, 'client timeout')).toMatchObject({
      error: { code: 'runtime_timeout' }
    })
    await observe(aborted, 'socket-close cancellation at preparation')
    expect(mutations.updateIssueForAgent).not.toHaveBeenCalled()
    release()
    await new Promise((resolve) => setImmediate(resolve))
    expect(mutations.updateIssueForAgent).not.toHaveBeenCalled()
  } finally {
    release()
    await vi.advanceTimersByTimeAsync(30)
    await observe(pending, 'client settlement')
    const request = dispatch.mock.results[0]
    if (request?.type === 'return') {
      await observe(
        Promise.resolve(request.value).catch(() => {}),
        'dispatch settlement'
      )
    }
  }
  expect(mutations.updateIssueForAgent).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
