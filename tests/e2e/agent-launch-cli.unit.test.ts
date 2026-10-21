import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_LAUNCH_RUNTIME_CAPABILITIES } from '../../src/shared/agent-launch-runtime-capability'
import { openTestAgentSessionRecordStore } from '../../src/main/runtime/agent-session-record-store-test-harness'
import { RuntimeClient, RuntimeClientError } from '../../src/cli/runtime-client'
import { callAgentLaunch, readCliAgentLaunch } from '../../src/cli/agent-launch-request'
import { parseArgs } from '../../src/cli/args'
import { AGENT_LAUNCH_HANDLERS } from '../../src/cli/handlers/agent-launch'
import { createWorktreeWithAgent } from '../../src/cli/handlers/worktree-create-agent-launch'
import {
  methodNamed,
  rpcContext,
  runtimeStub,
  setAgentLaunchRecordStore
} from '../../src/main/runtime/rpc/methods/agent-launch.test-fixture'

const chatCreate = vi.hoisted(() => vi.fn())
const promptCommit = vi.hoisted(() => vi.fn(async () => 'message_test'))
const terminalPrompt = vi.hoisted(() => vi.fn(async () => true))
vi.mock('../../src/main/runtime/rpc/methods/structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: chatCreate
}))
vi.mock('../../src/main/runtime/rpc/methods/agent-launch-structured-prompt', () => ({
  commitStructuredAgentSessionLaunchPrompt: promptCommit
}))
vi.mock('../../src/main/runtime/rpc/methods/agent-launch-terminal-prompt', () => ({
  deliverTerminalAgentLaunchPrompt: terminalPrompt
}))
const { AGENT_LAUNCH_METHODS } = await import('../../src/main/runtime/rpc/methods/agent-launch')

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-launch-cli-'))
  setAgentLaunchRecordStore(await openTestAgentSessionRecordStore(directory))
  chatCreate.mockReset().mockResolvedValue({ ok: true, value: { sessionId: 'codex_test' } })
  promptCommit.mockClear()
  terminalPrompt.mockClear()
})
afterEach(async () => {
  setAgentLaunchRecordStore(null)
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

function hostClient(runtime: ReturnType<typeof runtimeStub>, loseReply = false) {
  const client = new RuntimeClient(directory, 60_000, null, null)
  let lost = false
  vi.spyOn(client, 'call').mockImplementation(async (name, params) => {
    if (name === 'status.get') {
      return {
        id: 'status',
        ok: true,
        result: { capabilities: [...AGENT_LAUNCH_RUNTIME_CAPABILITIES] },
        _meta: { runtimeId: 'runtime-1' }
      }
    }
    if (name === 'projectGroup.list') {
      return { id: 'groups', ok: true, result: { groups: [] }, _meta: { runtimeId: 'runtime-1' } }
    }
    if (name === 'repo.list') {
      return { id: 'repos', ok: true, result: { repos: [] }, _meta: { runtimeId: 'runtime-1' } }
    }
    const method = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launchReplay')
    expect(name).toBe('agent.launchReplay')
    const result = await method.handler(method.params.parse(params), rpcContext(runtime, {}))
    if (loseReply && !lost) {
      lost = true
      throw new RuntimeClientError(
        'runtime_unavailable',
        'The Orca runtime closed the connection before responding. Restart Orca and try again.'
      )
    }
    return { id: 'reply', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
  })
  return client
}

const existing = { kind: 'existing', worktree: 'id:wt-7' } as const
const create = {
  kind: 'create-worktree',
  create: { repo: 'id:repo-1', name: 'task', activate: false }
} as const

describe('CLI launch through host surface creation and replay admission', () => {
  it('keeps a new worktree background chat inactive', async () => {
    await callAgentLaunch(
      hostClient(runtimeStub()),
      { agent: 'codex' },
      { target: create, presentation: 'background' },
      AGENT_LAUNCH_RUNTIME_CAPABILITIES
    )
    expect(chatCreate.mock.calls[0]?.[0].activate).toBe(false)
  })

  it('honors explicit local chat focus', async () => {
    await callAgentLaunch(
      hostClient(runtimeStub()),
      { agent: 'codex' },
      { target: existing, presentation: 'focused' },
      AGENT_LAUNCH_RUNTIME_CAPABILITIES
    )
    expect(chatCreate.mock.calls[0]?.[0].activate).toBe(true)
  })

  it('passes local terminal focus to the runtime', async () => {
    const runtime = runtimeStub({ settings: {} })
    await callAgentLaunch(
      hostClient(runtime),
      { agent: 'codex' },
      { target: existing, presentation: 'focused' },
      AGENT_LAUNCH_RUNTIME_CAPABILITIES
    )
    expect(runtime.createTerminal).toHaveBeenCalledWith(
      'id:wt-7',
      expect.objectContaining({ presentation: 'focused' })
    )
  })

  it.each([existing, create])(
    'a lost accepted reply replays without a second chat or prompt: %j',
    async (target) => {
      const runtime = runtimeStub()
      const launch = {
        agent: 'codex',
        prompt: { text: 'Fix the repo\nThen test it', delivery: 'submit' }
      } as const
      let operationId: string | undefined
      try {
        await callAgentLaunch(
          hostClient(runtime, true),
          launch,
          { target, presentation: 'background' },
          AGENT_LAUNCH_RUNTIME_CAPABILITIES
        )
        throw new Error('Expected lost reply')
      } catch (error) {
        expect(error).toBeInstanceOf(RuntimeClientError)
        if (
          !(error instanceof RuntimeClientError) ||
          !error.data ||
          typeof error.data !== 'object' ||
          !('operationId' in error.data) ||
          typeof error.data.operationId !== 'string'
        ) {
          throw error
        }
        operationId = error.data.operationId
        expect(error.message).not.toContain('try again')
        expect(error.data).toMatchObject({ retrySafe: true, operationId })
      }
      const result = await callAgentLaunch(
        hostClient(runtime),
        readCliAgentLaunch(
          new Map([
            ['prompt', launch.prompt.text],
            ['retry-launch', operationId ?? '']
          ]),
          'codex',
          { createsWorktree: target.kind === 'create-worktree' }
        ),
        { target, presentation: 'background' },
        AGENT_LAUNCH_RUNTIME_CAPABILITIES
      )
      expect(result.result.prompt).toMatchObject({
        outcome: 'journaled',
        messageId: 'message_test'
      })
      expect(chatCreate).toHaveBeenCalledTimes(1)
      expect(promptCommit).toHaveBeenCalledTimes(1)
      expect(runtime.createManagedWorktree).toHaveBeenCalledTimes(
        target.kind === 'create-worktree' ? 1 : 0
      )
    }
  )

  it.each([existing, create])(
    'rejects empty recovery IDs after a lost terminal reply and preserves valid replay: %j',
    async (target) => {
      const runtime = runtimeStub({ settings: {} })
      const argv = ['--agent', 'codex', '--prompt', 'Fix the repo\nThen test']
      const launch = readCliAgentLaunch(parseArgs(argv).flags, 'codex', {
        createsWorktree: target.kind === 'create-worktree'
      })
      const initialClient = hostClient(runtime, true)
      let operationId: string | undefined
      try {
        await callAgentLaunch(
          initialClient,
          launch,
          { target, presentation: 'background' },
          AGENT_LAUNCH_RUNTIME_CAPABILITIES
        )
        throw new Error('Expected lost reply')
      } catch (error) {
        if (
          !(error instanceof RuntimeClientError) ||
          !error.data ||
          typeof error.data !== 'object' ||
          !('operationId' in error.data) ||
          typeof error.data.operationId !== 'string'
        ) {
          throw error
        }
        operationId = error.data.operationId
      }
      const retryClient = hostClient(runtime)
      for (const retryArgs of [['--retry-launch', ''], ['--retry-launch=']]) {
        await expect(async () => {
          const retry = readCliAgentLaunch(parseArgs([...argv, ...retryArgs]).flags, 'codex', {
            createsWorktree: target.kind === 'create-worktree'
          })
          await callAgentLaunch(
            retryClient,
            retry,
            { target, presentation: 'background' },
            AGENT_LAUNCH_RUNTIME_CAPABILITIES
          )
        }).rejects.toMatchObject({ code: 'invalid_argument' })
      }
      expect(retryClient.call).not.toHaveBeenCalled()
      await callAgentLaunch(
        retryClient,
        readCliAgentLaunch(
          parseArgs([...argv, '--retry-launch', operationId ?? '']).flags,
          'codex',
          {
            createsWorktree: target.kind === 'create-worktree'
          }
        ),
        { target, presentation: 'background' },
        AGENT_LAUNCH_RUNTIME_CAPABILITIES
      )
      expect(retryClient.call).toHaveBeenCalledExactlyOnceWith(
        'agent.launchReplay',
        vi.mocked(initialClient.call).mock.calls[0]?.[1]
      )
      expect(terminalPrompt).toHaveBeenCalledTimes(1)
      expect(runtime.createTerminal).toHaveBeenCalledTimes(target.kind === 'existing' ? 1 : 0)
      expect(runtime.createManagedWorktree).toHaveBeenCalledTimes(
        target.kind === 'create-worktree' ? 1 : 0
      )
    }
  )

  it('refuses replay on an older replacement host without sending any launch', async () => {
    const client = hostClient(runtimeStub())
    const operationId = `${Date.now()}-${'a'.repeat(32)}`
    await expect(
      callAgentLaunch(client, { agent: 'codex', operationId }, { target: existing }, [
        'agent.launch.v2',
        'agent.launch.local-presentation.v1'
      ])
    ).rejects.toThrow('do not retry without --retry-launch')
    expect(client.call).not.toHaveBeenCalled()
  })

  it.each([existing, create])(
    'refuses a v2-only prompted launch before creating anything: %j',
    async (target) => {
      const runtime = runtimeStub()
      await expect(
        callAgentLaunch(
          hostClient(runtime),
          { agent: 'codex', prompt: { text: 'Long\nMultiline', delivery: 'submit' } },
          { target },
          ['agent.launch.v2']
        )
      ).rejects.toThrow('cannot safely carry launch prompts')
      expect(chatCreate).not.toHaveBeenCalled()
      expect(runtime.createTerminal).not.toHaveBeenCalled()
    }
  )

  it('refuses hosts without local presentation before creating anything', async () => {
    const client = hostClient(runtimeStub())
    await expect(
      callAgentLaunch(
        client,
        { agent: 'codex' },
        { target: existing, presentation: 'background' },
        ['agent.launch.v2']
      )
    ).rejects.toThrow('cannot honor CLI launch focus or background')
    expect(client.call).not.toHaveBeenCalled()
  })

  it('gives inspection-only recovery after an ambiguous legacy create and never falls back again', async () => {
    const client = new RuntimeClient(directory, 60_000, null, null)
    const call = vi
      .spyOn(client, 'call')
      .mockResolvedValueOnce({
        id: 'status',
        ok: true,
        result: { capabilities: [] },
        _meta: { runtimeId: 'runtime-1' }
      })
      .mockRejectedValueOnce(
        new RuntimeClientError('runtime_unavailable', 'Restart Orca and try again.')
      )
    await expect(
      createWorktreeWithAgent({
        client,
        flags: new Map(),
        create: create.create,
        launch: { agent: 'codex' },
        json: true
      })
    ).rejects.toMatchObject({
      code: 'agent_session_operation_unknown',
      data: {
        retrySafe: false,
        nextSteps: expect.arrayContaining([expect.stringContaining('Do not repeat')])
      }
    })
    expect(call).toHaveBeenCalledTimes(2)
  })

  it.each([undefined, 'current'])(
    'uses the innermost native folder for %s before Git fallback',
    async (selector) => {
      const client = hostClient(runtimeStub())
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const call = vi.mocked(client.call)
      call.mockResolvedValueOnce({
        id: 'folders',
        ok: true,
        result: {
          folderWorkspaces: [
            { id: 'outer', folderPath: '/tmp/repo' },
            { id: 'remote', folderPath: '/tmp/repo/nested/deeper', connectionId: 'ssh-1' },
            { id: 'nested', folderPath: '/tmp/repo/nested' }
          ]
        },
        _meta: { runtimeId: 'runtime-1' }
      })
      const flags = new Map<string, string | boolean>([['agent', 'codex']])
      if (selector) {
        flags.set('worktree', selector)
      }
      await AGENT_LAUNCH_HANDLERS['agent launch']({
        flags,
        client,
        cwd: '/tmp/repo/nested/deeper',
        json: true
      })
      expect(call).not.toHaveBeenCalledWith('worktree.list', expect.anything())
      expect(call).toHaveBeenCalledWith(
        'agent.launchReplay',
        expect.objectContaining({ target: { kind: 'existing', worktree: 'id:folder:nested' } })
      )
    }
  )

  it('refuses remote cwd inference for current', async () => {
    const client = hostClient(runtimeStub())
    vi.spyOn(client, 'isRemote', 'get').mockReturnValue(true)
    const flags = new Map<string, string | boolean>([
      ['agent', 'codex'],
      ['worktree', 'current']
    ])
    await expect(
      AGENT_LAUNCH_HANDLERS['agent launch']({ flags, client, cwd: '/tmp/repo', json: true })
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(client.call).not.toHaveBeenCalled()
  })
})
