import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { rememberPaneKeyForPty, ptyPaneKey, paneKeyPtyId } from '../main/ipc/pty/pane/key-state'
import { AgentHookServer, _internals } from '../main/agent-hooks/server'
import { RelayAgentHookServer } from './agent-hook-server'
import type { AgentHookRelayEnvelope } from '../shared/agent-hook-relay'
import { makePaneKey } from '../shared/stable-pane-id'

vi.mock('../main/telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../main/telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))
const paneKey = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const sessionId = '44444444-4444-4444-8444-444444444444'
const promptId = '22222222-2222-4222-8222-222222222222'
const jsonl = (...records: unknown[]) => records.map((row) => `${JSON.stringify(row)}\n`).join('')
const event = (payload: Record<string, unknown>) => ({ type: 'event_msg', payload })
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup()
  }
})

async function start(kind: 'local' | 'guest') {
  _internals.resetCachesForTests()
  const directory = mkdtempSync(join(tmpdir(), 'orca-quota-publication-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'transcript.jsonl')
  let latest: AgentHookRelayEnvelope | undefined
  const local = new AgentHookServer()
  const relay = new RelayAgentHookServer({
    endpointDir: directory,
    forward: (row) => {
      latest = row
      local.ingestRemote(row, 'wsl:Ubuntu')
    }
  })
  const server = kind === 'guest' ? relay : local
  if (kind === 'guest') {
    await local.start({ env: 'production', userDataPath: directory })
    cleanups.push(() => local.stop())
    local.beginRemoteRelaySession('wsl:Ubuntu')
  }
  await (kind === 'guest'
    ? relay.start()
    : local.start({ env: 'production', userDataPath: directory }))
  cleanups.push(() => server.stop())
  const env = kind === 'guest' ? undefined : local.buildPtyEnv()
  const { port, token } =
    kind === 'guest'
      ? relay.getCoordinates()
      : {
          port: env!.ORCA_AGENT_HOOK_PORT,
          token: env!.ORCA_AGENT_HOOK_TOKEN
        }
  return {
    path,
    local,
    validate: (value: unknown) => relay.validateTerminalUsageLimit(value),
    read: () => (kind === 'guest' ? latest : local.getStatusSnapshotForPane(paneKey)[0]),
    post: async (source: 'claude' | 'codex', payload: Record<string, unknown>) => {
      const result = await fetch(`http://127.0.0.1:${port}/hook/${source}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': token,
          Connection: 'close'
        },
        body: JSON.stringify({
          paneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: {
            session_id: sessionId,
            transcript_path: path,
            ...payload
          }
        })
      })
      expect(result.status).toBe(204)
    }
  }
}

it.each(['local', 'guest'] as const)(
  '%s publishes a failed poll-only Codex root end once, without a Stop hook',
  async (kind) => {
    const host = await start(kind)
    writeFileSync(host.path, jsonl(event({ type: 'task_started', turn_id: 'root' })))
    await host.post('codex', {
      hook_event_name: 'UserPromptSubmit',
      turn_id: 'root',
      prompt: 'Finish'
    })
    appendFileSync(
      host.path,
      jsonl(
        event({
          type: 'token_count',
          info: null,
          rate_limits: {
            limit_id: 'codex',
            primary: { used_percent: 100, window_minutes: 300, resets_at: 1_893_756_137 }
          }
        }),
        event({
          type: 'task_complete',
          turn_id: 'root',
          error: { codex_error_info: 'usage_limit_exceeded' }
        })
      )
    )
    await expect.poll(() => host.read()?.turnEndedAt, { timeout: 4000 }).toBeTypeOf('number')
    const failed = host.read()!
    const main = 'payload' in failed ? failed.payload.mainAgent : failed.mainAgent
    expect(main).toMatchObject({ state: 'done', outcome: 'failure', usageLimit: {} })
    expect(failed.turnEndDisposition).toBe('identified')
    if ('payload' in failed) {
      expect(failed.hookEventName).toBeUndefined()
    }
    if (kind === 'guest') {
      const ptyId = 'quota-publication-pty'
      rememberPaneKeyForPty(ptyId, paneKey)
      cleanups.push(() => {
        ptyPaneKey.delete(ptyId)
        paneKeyPtyId.delete(paneKey)
      })
      const cut = { sessionId, turnEndedAt: failed.turnEndedAt! }
      const initial = host.local.prepareTerminalUsageLimitSource(paneKey, ptyId, cut)!
      cleanups.push(() => initial.dispose())
      expect(initial.isCurrent()).toBe(true)
      expect(host.validate(initial.remote!.request)).toEqual({ status: 'current' })
      const movedPane = makePaneKey('tab-2', '22222222-2222-4222-8222-222222222222')
      host.local.transferPaneAuthority(paneKey, movedPane, ptyId, Date.now(), {
        authorityVerified: true
      })
      expect(initial.isCurrent()).toBe(false)
      const moved = host.local.prepareTerminalUsageLimitSource(movedPane, ptyId, cut)!
      cleanups.push(() => moved.dispose())
      expect(moved.isCurrent()).toBe(true)
      expect(moved.remote!.request.paneKey).toBe(paneKey)
      expect(host.validate(moved.remote!.request)).toEqual({ status: 'current' })
      host.local.beginRemoteRelaySession('wsl:Ubuntu')
      expect(moved.isCurrent()).toBe(false)
    }

    await host.post('codex', { hook_event_name: 'Stop', turn_id: 'root' })
    expect(host.read()?.turnEndedAt).toBe(failed.turnEndedAt)
  }
)

it.each(['refine', 'new-meta-root', 'new-session'] as const)(
  'guest delayed Claude quota with existing text: %s',
  async (mode) => {
    const host = await start('guest')
    const user = {
      type: 'user',
      sessionId,
      promptId,
      uuid: 'user',
      parentUuid: null,
      isSidechain: false,
      message: { content: 'Finish' }
    }
    const assistant = {
      type: 'assistant',
      sessionId,
      uuid: 'answer',
      parentUuid: 'user',
      isSidechain: false,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Usage limit reached' }] }
    }
    writeFileSync(host.path, jsonl(user, assistant))
    await host.post('claude', {
      hook_event_name: 'UserPromptSubmit',
      prompt_id: promptId,
      prompt: 'Finish'
    })
    await host.post('claude', {
      hook_event_name: 'PostToolUse',
      prompt_id: promptId,
      tool_name: 'Bash',
      tool_response: 'Usage limit reached'
    })
    await host.post('claude', {
      hook_event_name: 'StopFailure',
      prompt_id: promptId,
      error: 'rate_limit'
    })
    const failed = host.read()!
    expect('payload' in failed && failed.payload.lastAssistantMessage).toBe('Usage limit reached')
    const quota = {
      ...assistant,
      uuid: 'quota',
      parentUuid: 'answer',
      apiError: 'usage_limit_reached',
      error: 'rate_limit'
    }
    if (mode !== 'new-session') {
      appendFileSync(host.path, jsonl(quota))
    }
    if (mode === 'new-meta-root') {
      appendFileSync(
        host.path,
        jsonl({ ...user, uuid: 'meta', promptId: undefined, isMeta: true, parentUuid: 'quota' })
      )
    }
    if (mode === 'new-session') {
      await host.post('claude', {
        hook_event_name: 'SessionStart',
        source: 'startup',
        session_id: '55555555-5555-4555-8555-555555555555'
      })
    }
    if (mode === 'new-session') {
      appendFileSync(host.path, jsonl(quota))
    }
    if (mode === 'refine') {
      await expect
        .poll(() => {
          const row = host.read()
          return row && 'payload' in row ? row.payload.mainAgent?.usageLimit : undefined
        })
        .toEqual({})
      expect(host.read()?.turnEndedAt).toBe(failed.turnEndedAt)
      const request = { paneKey, sessionId, turnEndedAt: failed.turnEndedAt, source: 'claude' }
      expect(host.validate(request)).toEqual({ status: 'current' })
      expect(host.validate({ ...request, launchToken: 'different-owner' })).toEqual({
        status: 'changed'
      })
      appendFileSync(
        host.path,
        jsonl({
          ...user,
          uuid: 'next-native-input',
          promptId: undefined,
          isMeta: true,
          parentUuid: 'quota'
        })
      )
      expect(host.validate(request)).toEqual({ status: 'changed' })
    } else {
      await new Promise((resolve) => setTimeout(resolve, 350))
      const row = host.read()!
      expect('payload' in row && row.payload.mainAgent?.usageLimit).toBeUndefined()
    }
  }
)
