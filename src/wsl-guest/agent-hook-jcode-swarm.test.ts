import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RelayAgentHookServer } from './agent-hook-server'
import { AgentHookServer } from '../main/agent-hooks/server'
import { PANE, buildBody } from '../main/agent-hooks/server.test-fixtures'
import {
  rootMetadata,
  workerMetadata,
  tigressHooks
} from '../shared/agent-hook-listener-jcode-swarm-fixtures'
import type { AgentHookRelayEnvelope } from '../shared/agent-hook-relay'
import { AGENT_STATUS_STALE_AFTER_MS } from '../shared/agent-status-types'

describe('Jcode relay host acceptance', () => {
  let dir: string
  let relay: RelayAgentHookServer
  let forwarded: AgentHookRelayEnvelope[]
  let launchToken: string | undefined
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jcode-relay-swarm-'))
    vi.stubEnv('JCODE_HOME', join(dir, 'jcode'))
    forwarded = []
    launchToken = undefined
    relay = new RelayAgentHookServer({
      endpointDir: dir,
      getAgentLaunchToken: () => launchToken,
      forward: (event) => forwarded.push(event)
    })
  })
  afterEach(() => {
    relay.stop()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })
  function documents() {
    const sessions = join(dir, 'jcode', 'sessions')
    mkdirSync(sessions, { recursive: true })
    for (const metadata of [rootMetadata, workerMetadata, { ...rootMetadata, id: 'old-root' }]) {
      writeFileSync(join(sessions, `${metadata.id}.json`), JSON.stringify(metadata))
    }
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 251)
  }
  async function post(payload: Record<string, unknown>, token?: string) {
    const coords = relay.getCoordinates()
    expect(
      (
        await fetch(`http://127.0.0.1:${coords.port}/hook/jcode`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': coords.token },
          body: JSON.stringify(buildBody(payload, { launchToken: token }))
        })
      ).status
    ).toBe(204)
  }
  const start = () => ({ ...tigressHooks[0], event: 'turn_start', prompt: 'root prompt' })
  const end = () => ({
    ...start(),
    event: 'turn_end',
    status: 'ok',
    last_assistant_text: 'root reply'
  })

  it('forwards silent child expiry and later working activity from the execution host', async () => {
    documents()
    vi.restoreAllMocks()
    await relay.start()
    vi.useFakeTimers()
    launchToken = 'active-launch'
    await post(start(), launchToken)
    await post(tigressHooks[4], launchToken)
    await post(end(), launchToken)
    await vi.advanceTimersByTimeAsync(AGENT_STATUS_STALE_AFTER_MS + 1)
    expect(forwarded.at(-1)?.payload).toMatchObject({
      state: 'done',
      mainAgent: { state: 'done' },
      subagents: [{ state: 'unverifiable' }]
    })
    // Negative control: captured root tool attributed to this worker as pre_tool.
    await post(
      { ...tigressHooks[1], session_id: workerMetadata.id, event: 'pre_tool' },
      launchToken
    )
    expect(forwarded.at(-1)?.payload).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done' },
      subagents: [{ state: 'working' }]
    })
    const liveCount = forwarded.length
    launchToken = 'replacement-launch'
    await vi.advanceTimersByTimeAsync(AGENT_STATUS_STALE_AFTER_MS + 1)
    expect(forwarded).toHaveLength(liveCount)
    relay.clearPaneState(PANE)
    const count = forwarded.length
    await vi.advanceTimersByTimeAsync(AGENT_STATUS_STALE_AFTER_MS + 1)
    expect(forwarded).toHaveLength(count)
  })

  it.each(['http', 'spool'])(
    'delayed_metadata_preserves_buffered_root_boundaries_before_worker_ingress via %s',
    async (transport) => {
      if (transport === 'spool') {
        mkdirSync(join(dir, 'spool'))
        writeFileSync(
          join(dir, 'spool', 'jcode.jsonl'),
          `${[start(), end()]
            .map((payload) =>
              JSON.stringify({
                paneKey: PANE,
                tabId: 'tab-1',
                worktreeId: 'wt-1',
                source: 'jcode',
                launchToken: 'launch-root',
                payload,
                receivedAt: Date.now()
              })
            )
            .join('\n')}\n`
        )
      }
      await relay.start()
      if (transport === 'http') {
        await post(start(), 'launch-root')
        await post(end(), 'launch-root')
      }
      expect(forwarded).toEqual([])
      documents()
      await post(tigressHooks[2])
      expect(forwarded.map((event) => event.hookEventName)).toEqual([
        'turn_start',
        'turn_end',
        undefined
      ])
      expect(forwarded.slice(0, 2).map((event) => event.launchToken)).toEqual([
        'launch-root',
        'launch-root'
      ])
      expect(forwarded.slice(0, 2).map((event) => event.isReplay === true)).toEqual([
        transport === 'spool',
        transport === 'spool'
      ])
      expect(forwarded[0].hasExplicitPrompt).toBe(true)
      if (transport === 'http') {
        expect(forwarded[1].turnEndDisposition).toBe('identified')
        expect(Number.isFinite(forwarded[1].turnEndedAt)).toBe(true)
        expect(forwarded[2].turnEndedAt).toBe(forwarded[1].turnEndedAt)
      } else {
        expect(forwarded[1].turnEndedAt).toBeUndefined()
      }
      expect(forwarded[2].hasExplicitPrompt).toBeUndefined()
    }
  )

  it.each(['readable', 'pending', 'buffered'])(
    'rejected_old_launch_before_fresh_root_first_hook_does_not_bind: %s',
    async (metadata) => {
      await relay.start()
      // Negative control: stale launch belongs to a different root session.
      const oldStart = { ...start(), session_id: 'old-root' }
      if (metadata === 'buffered') {
        await post(oldStart, 'old')
      }
      launchToken = 'fresh'
      if (metadata !== 'pending') {
        documents()
      }
      await post(oldStart, 'old')
      expect(forwarded).toEqual([])
      documents()
      await post({ ...start(), prompt: 'fresh prompt' }, 'fresh')
      await post(tigressHooks[4], 'fresh')
      expect(forwarded).toHaveLength(2)
      expect(forwarded[1]).toMatchObject({
        providerSession: { id: rootMetadata.id },
        payload: {
          prompt: 'fresh prompt',
          model: start().model,
          subagents: [expect.objectContaining({ id: workerMetadata.id })]
        }
      })
    }
  )

  it('resolves on execution host and desktop ingest never reads conflicting local metadata', async () => {
    documents()
    await relay.start()
    await post(start())
    await post(tigressHooks[4])
    const desktop = new AgentHookServer()
    const localHome = join(dir, 'desktop', 'sessions')
    mkdirSync(localHome, { recursive: true })
    writeFileSync(
      join(localHome, `${rootMetadata.id}.json`),
      JSON.stringify({ ...rootMetadata, parent_id: 'wrong-parent' })
    )
    vi.stubEnv('JCODE_HOME', join(dir, 'desktop'))
    try {
      for (const envelope of forwarded) {
        desktop.ingestRemote(envelope, 'ssh-host')
      }
      expect(desktop.getStatusSnapshot()[0]).toMatchObject({
        providerSession: { id: rootMetadata.id },
        prompt: 'root prompt',
        subagents: [expect.objectContaining({ id: workerMetadata.id, agentType: 'retriever' })]
      })
      expect(desktop._getStateForTests().jcodeSessions.bindings.size).toBe(0)
      expect(desktop._getStateForTests().jcodeRootPayloadByPaneKey.size).toBe(0)
      desktop.ingestRemote(
        {
          paneKey: PANE,
          payload: { state: 'done', prompt: 'old peer', agentType: 'jcode' },
          providerSession: { key: 'session_id', id: rootMetadata.id }
        },
        'ssh-host'
      )
      expect(desktop.getStatusSnapshot()[0]).toMatchObject({
        state: 'done',
        prompt: 'old peer',
        providerSession: { id: rootMetadata.id }
      })
    } finally {
      desktop.stop()
    }
  })

  it('forwards root identity-only session_start to desktop without local attribution', async () => {
    documents()
    await relay.start()
    await post(tigressHooks[0])
    expect(forwarded).toHaveLength(1)
    const desktop = new AgentHookServer()
    try {
      desktop.ingestRemote(forwarded[0], 'ssh-host')
      expect(desktop.getStatusSnapshot()[0]).toMatchObject({
        providerSessionOnly: true,
        providerSession: { id: rootMetadata.id }
      })
      expect(desktop._getStateForTests().jcodeSessions.bindings.size).toBe(0)
    } finally {
      desktop.stop()
    }
  })

  it('clears canonical and provider claims on pane teardown', async () => {
    documents()
    await relay.start()
    await post(start())
    await post(tigressHooks[4])
    relay.clearPaneState(PANE)
    const count = forwarded.length
    await post(tigressHooks[5])
    expect(forwarded).toHaveLength(count)
  })
})
