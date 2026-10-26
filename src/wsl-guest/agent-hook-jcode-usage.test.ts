import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RelayAgentHookServer } from './agent-hook-server'
import { AgentHookServer } from '../main/agent-hooks/server'
import { buildBody } from '../main/agent-hooks/server.test-fixtures'
import {
  skunkHooks,
  skunkMetadata,
  usageA
} from '../shared/agent-hook-listener-jcode-usage-fixtures'
import type { AgentHookRelayEnvelope } from '../shared/agent-hook-relay'

describe('Jcode usage relay transport', () => {
  let dir: string
  let relay: RelayAgentHookServer
  let forwarded: AgentHookRelayEnvelope[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jcode-relay-usage-'))
    vi.stubEnv('JCODE_HOME', join(dir, 'jcode'))
    forwarded = []
    relay = new RelayAgentHookServer({
      endpointDir: dir,
      forward: (event) => forwarded.push(event)
    })
  })

  afterEach(() => {
    relay.stop()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  function documents() {
    const sessions = join(dir, 'jcode', 'sessions')
    mkdirSync(sessions, { recursive: true })
    writeFileSync(join(sessions, `${skunkMetadata.id}.json`), JSON.stringify(skunkMetadata))
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 251)
  }

  async function post(payload: Record<string, unknown>) {
    const coords = relay.getCoordinates()
    expect(
      (
        await fetch(`http://127.0.0.1:${coords.port}/hook/jcode`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': coords.token },
          body: JSON.stringify(buildBody(payload))
        })
      ).status
    ).toBe(204)
  }

  it('carries new-shape usage through relay and desktop', async () => {
    documents()
    await relay.start()
    await post(skunkHooks.turnStartA)
    await post(skunkHooks.turnEndA)
    expect(forwarded.at(-1)?.payload.lastTurnUsage).toEqual(usageA)
    const desktop = new AgentHookServer()
    try {
      desktop.ingestRemote(forwarded.at(-1)!, 'ssh-host')
      expect(desktop.getStatusSnapshot()[0].lastTurnUsage).toEqual(usageA)
    } finally {
      desktop.stop()
    }
  })

  it('keeps an old-shape turn_end free of usage end to end', async () => {
    documents()
    await relay.start()
    await post(skunkHooks.turnStartA)
    // Negative control: captured turn A with every token field removed.
    const tokenless: Record<string, unknown> = { ...skunkHooks.turnEndA }
    for (const key of Object.keys(tokenless)) {
      if (key.endsWith('_tokens')) {
        delete tokenless[key]
      }
    }
    await post(tokenless)
    expect(forwarded.at(-1)?.payload).not.toHaveProperty('lastTurnUsage')
    const desktop = new AgentHookServer()
    try {
      desktop.ingestRemote(forwarded.at(-1)!, 'ssh-host')
      const row = desktop.getStatusSnapshot()[0]
      expect(row).not.toHaveProperty('lastTurnUsage')
      expect(row).toMatchObject({
        state: 'done',
        agentType: 'jcode',
        model: skunkHooks.turnEndA.model
      })
    } finally {
      desktop.stop()
    }
  })

  it('ingests a relay payload that never sends the usage field', async () => {
    documents()
    await relay.start()
    await post(skunkHooks.turnStartA)
    await post(skunkHooks.turnEndA)
    const desktop = new AgentHookServer()
    const oldPeerDesktop = new AgentHookServer()
    try {
      const envelope = forwarded.at(-1)!
      desktop.ingestRemote(envelope, 'ssh-host')
      const row = desktop.getStatusSnapshot()[0]
      expect(row.lastTurnUsage).toEqual(usageA)
      const { lastTurnUsage: _dropped, ...rest } = row
      // Negative control: an old relay never sends the new optional field.
      const oldPeerEnvelope = structuredClone(envelope)
      delete oldPeerEnvelope.payload.lastTurnUsage
      oldPeerDesktop.ingestRemote(oldPeerEnvelope, 'ssh-host')
      const oldPeerRow = oldPeerDesktop.getStatusSnapshot()[0]
      expect(oldPeerRow).not.toHaveProperty('lastTurnUsage')
      expect(row.observation?.authorityId).toMatch(/^main-agent-hooks:/)
      expect(oldPeerRow.observation?.authorityId).toMatch(/^main-agent-hooks:/)
      expect({
        ...oldPeerRow,
        observation: { ...oldPeerRow.observation, authorityId: undefined }
      }).toEqual({ ...rest, observation: { ...rest.observation, authorityId: undefined } })
      expect(oldPeerRow).toMatchObject({
        state: 'done',
        agentType: 'jcode'
      })
    } finally {
      desktop.stop()
      oldPeerDesktop.stop()
    }
  })
})
