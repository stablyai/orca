import '../../src/main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearTimeout as clearRealTimeout, setTimeout as setRealTimeout } from 'node:timers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { main } from '../../src/cli/index'
import { RuntimeClient } from '../../src/cli/runtime-client'
import * as mutations from '../../src/main/linear/linear-issue-mutations'
import * as comments from '../../src/main/linear/linear-issue-comments'
import * as relations from '../../src/main/linear/issue-relation-write'
import { LinearWriteFailure } from '../../src/main/linear/linear-issue-write-support'
import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../../src/main/runtime/runtime-rpc'
import { LINEAR_AGENT_ACCESS_METHODS } from '../../src/main/runtime/rpc/methods/linear-agent-access'

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

const verbs = [
  ['status', 'set', 'ENG-1', '--to', 'Done'],
  ['priority', 'set', 'ENG-1', '--to', 'high'],
  ['priority', 'clear', 'ENG-1'],
  ['assignee', 'set', 'ENG-1', '--to-id', writeId],
  ['assignee', 'set', 'ENG-1', '--me'],
  ['assignee', 'clear', 'ENG-1'],
  ['label', 'add', 'ENG-1', '--label', 'Bug'],
  ['label', 'remove', 'ENG-1', '--label', 'Bug'],
  ['label', 'set', 'ENG-1', '--label', 'Bug'],
  ['estimate', 'set', 'ENG-1', '--to', '3'],
  ['estimate', 'clear', 'ENG-1'],
  ['due-date', 'set', 'ENG-1', '--to', '2026-11-01'],
  ['due-date', 'clear', 'ENG-1'],
  ['relation', 'add', 'ENG-1', '--related', 'ENG-2', '--type', 'blocks'],
  ['relation', 'remove', 'ENG-1', '--related', 'ENG-2', '--type', 'blocks'],
  ['comment', 'add', 'ENG-1', '--body', 'new', '--write-id', writeId],
  ['comment', 'edit', writeId, '--body', 'new'],
  ['comment', 'delete', writeId],
  ['attach', 'ENG-1', '--url', 'https://example.com', '--write-id', writeId],
  ['create', '--title', 'New', '--team', 'ENG', '--write-id', writeId],
  ['save-issue', 'ENG-1', '--title', 'New'],
  ['save-issue', '--title', 'New', '--team', 'ENG', '--write-id', writeId]
].map((argv) => ({ name: argv.join(' '), argv }))

it.each(verbs)(
  'preserves $name recovery through CLI, socket, admission and dispatch',
  async ({ argv }) => {
    if (argv[1] === 'clear' || argv[1] === 'remove') {
      vi.mocked(runtime.readLinearAgentIssueWriteRecord).mockResolvedValue({
        ...issue,
        priority: 2,
        assignee: { id: 'user-2', displayName: 'Other' },
        estimate: 3,
        dueDate: '2026-11-01',
        labelIds: ['bug'],
        labels: [{ id: 'bug', name: 'Bug' }]
      })
    }
    await main(['linear', ...argv, '--json'], '/tmp')
    const envelope = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]))
    expect(envelope).toMatchObject({
      ok: false,
      error: { code: 'linear_write_unconfirmed', data: { nextSteps: [expect.any(String)] } }
    })
    const nextSteps: string[] = envelope.error.data.nextSteps
    expect(nextSteps[0]).toContain('orca linear')
    if (argv.includes('--write-id')) {
      expect(nextSteps[0]).toContain(`--write-id=${writeId}`)
    }
    expect(process.exitCode).toBe(1)
    vi.mocked(console.error).mockClear()
    process.exitCode = 0
    await main(['linear', ...argv], '/tmp')
    const stderr = vi
      .mocked(console.error)
      .mock.calls.map((call) => String(call[0]))
      .join('\n')
    for (const step of nextSteps) {
      expect(stderr).toContain(step)
    }
    expect(process.exitCode).toBe(1)
  }
)

const classifiedFailures = [
  {
    kind: 'failed',
    diagnostic: 'GraphQL validation error: Unknown argument body (BAD_USER_INPUT)'
  },
  { kind: 'network', diagnostic: 'getaddrinfo ENOTFOUND api.linear.app' },
  { kind: 'duplicate_id', diagnostic: 'Duplicate id on comment mutation (BAD_USER_INPUT)' }
] as const
const failureCases = verbs
  .filter(({ argv }) => argv[0] === 'comment' && ['edit', 'delete'].includes(argv[1]))
  .flatMap((command) => classifiedFailures.map((input) => ({ ...command, ...input })))
const diagnosticControls = classifiedFailures
  .filter(({ kind }) => kind !== 'duplicate_id')
  .map((input) => ({ name: 'status set', argv: verbs[0].argv, ...input }))

it.each([...failureCases, ...diagnosticControls])(
  'preserves the prior $name $kind failure contract through the real CLI',
  async ({ argv, kind, diagnostic }) => {
    failure = new LinearWriteFailure(kind, diagnostic)
    const expectedMessage =
      argv[0] === 'comment'
        ? 'Linear could not complete the comment change. Retry after checking the comment.'
        : diagnostic
    await main(['linear', ...argv, '--json'], '/tmp')
    const envelope = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]))
    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: kind === 'network' ? 'linear_network_error' : 'linear_write_failed',
        message: expectedMessage
      }
    })
    expect(process.exitCode).toBe(1)
    vi.mocked(console.error).mockClear()
    process.exitCode = 0
    await main(['linear', ...argv], '/tmp')
    const stderr = vi
      .mocked(console.error)
      .mock.calls.map((call) => String(call[0]))
      .join('\n')
    expect(stderr).toContain(expectedMessage)
    if (argv[0] === 'comment') {
      expect(stderr).not.toContain(diagnostic)
    }
    expect(process.exitCode).toBe(1)
  }
)

it('returns a confirmed CLI write over the unchanged wire payload', async () => {
  vi.mocked(mutations.updateIssueForAgent).mockImplementation(
    async (_id, _fields, _workspace, options) => {
      options?.beforeInvoke?.()
      return { ...issue, state: { id: 'done', name: 'Done' } }
    }
  )
  await main(['linear', 'status', 'set', 'ENG-1', '--to', 'Done', '--json'], '/tmp')
  expect(JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]))).toMatchObject({
    ok: true,
    result: { state: { id: 'done' } }
  })
  expect(mutations.updateIssueForAgent).toHaveBeenCalledTimes(1)
  expect(process.exitCode).toBe(0)
})

it('ends a stalled CLI preparation before its client timeout without a late write', async () => {
  let release = () => {}
  let entered = () => {}
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  vi.mocked(runtime.resolveLinearAgentWriteTarget).mockImplementation(() => {
    entered()
    return new Promise((resolve) => {
      release = () => resolve(target)
    })
  })
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const pending = main(['linear', 'status', 'set', 'ENG-1', '--to', 'Done', '--json'], '/tmp')
  try {
    await observe(started, 'preparation admission')
    await vi.advanceTimersByTimeAsync(30_000)
    await observe(pending, 'CLI preparation timeout')
    expect(JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]))).toMatchObject({
      error: {
        code: 'linear_timeout',
        message: 'The Linear action stopped before a change was attempted.'
      }
    })
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(mutations.updateIssueForAgent).not.toHaveBeenCalled()
  } finally {
    release()
    await observe(pending, 'CLI settlement')
  }
})

it.each(['status', 'duplicate comment'] as const)(
  'exposes truthful invoked deadline cause and recovery in %s CLI JSON',
  async (verb) => {
    let release = () => {}
    let entered = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    vi.mocked(mutations.updateIssueForAgent).mockImplementation(
      async (_id, _fields, _workspace, options) => {
        options?.beforeInvoke?.()
        entered()
        await held
        return { ...issue, state: { id: 'done', name: 'Done' } }
      }
    )
    vi.mocked(comments.addIssueCommentForAgent).mockImplementation(
      async (_id, _body, _workspace, options) => {
        options.beforeInvoke?.()
        throw new LinearWriteFailure('duplicate_id', 'Already exists')
      }
    )
    vi.mocked(runtime.getMatchingLinearCommentWrite)
      .mockResolvedValueOnce(null)
      .mockImplementation(async () => {
        entered()
        await held
        return comment
      })
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const argv =
      verb === 'status'
        ? ['status', 'set', 'ENG-1', '--to', 'Done']
        : ['comment', 'add', 'ENG-1', '--body', 'new', '--write-id', writeId]
    const pending = main(['linear', ...argv, '--json'], '/tmp')
    pending.catch(() => {})
    try {
      await observe(started, 'invocation or duplicate recovery admission')
      await vi.advanceTimersByTimeAsync(25_000)
      await observe(pending, 'CLI confirmation deadline')
      const envelope = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]))
      expect(envelope).toMatchObject({
        ok: false,
        error: {
          code: 'linear_write_unconfirmed',
          data: { cause: 'Linear write deadline elapsed before confirmation.' }
        }
      })
      if (verb === 'status') {
        expect(envelope.error.data.nextSteps).toEqual([
          expect.stringContaining('orca linear issue ENG-1')
        ])
      } else {
        expect(envelope.error.data).toMatchObject({
          writeId,
          nextSteps: [expect.stringContaining(`--write-id=${writeId}`)]
        })
        expect(runtime.getMatchingLinearCommentWrite).toHaveBeenCalledTimes(2)
      }
      expect(process.exitCode).toBe(1)
    } finally {
      release()
      await vi.advanceTimersByTimeAsync(0)
      await observe(pending, 'CLI settlement after late confirmation')
    }
    expect(
      verb === 'status' ? mutations.updateIssueForAgent : comments.addIssueCommentForAgent
    ).toHaveBeenCalledTimes(1)
    expect(console.log).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  }
)

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
