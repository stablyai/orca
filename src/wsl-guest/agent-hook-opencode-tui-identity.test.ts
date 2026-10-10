import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RelayAgentHookServer } from './agent-hook-server'
import type { AgentHookRelayEnvelope } from '../shared/agent-hook-relay'
import { makePaneKey } from '../shared/stable-pane-id'
import { drainAgentHookSpool } from '../shared/agent-hook-spool'
import { createHookListenerState } from '../shared/agent-hook-listener/listener-state'
import {
  bindOpenCodeSession,
  trackOpenCodePaneLaunchToken
} from '../shared/agent-hook-listener/opencode-session-registry'
import { ingestRelayHookSpoolRecord } from './agent-hook-spool-ingest'
import { buildRelayHookEnvelope } from './agent-hook-envelope-build'

const PANE_A = makePaneKey('tab-a', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
const PANE_B = makePaneKey('tab-b', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
const PANE_C = makePaneKey('tab-c', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')

describe('legacy TUI identity admitted by the execution-host relay', () => {
  let dir: string
  let server: RelayAgentHookServer
  const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
  const retired = new Set<string>()
  const authority = new Map<string, string>()

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'relay-opencode-tui-'))
    forward.mockClear()
    retired.clear()
    authority.clear()
    for (const pane of [PANE_A, PANE_B, PANE_C]) {
      authority.set(pane, 'live-token')
    }
    server = new RelayAgentHookServer({
      endpointDir: dir,
      forward,
      getAgentLaunchToken: (paneKey) => authority.get(paneKey),
      isPaneSurfaceRetired: (paneKey) => retired.has(paneKey)
    })
    await server.start()
  })
  afterEach(() => {
    server.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  async function post(
    paneKey: string,
    sessionID: string,
    hookEventName = 'SessionBusy',
    extra: Record<string, unknown> = {}
  ) {
    const { port, token } = server.getCoordinates()
    const response = await fetch(`http://127.0.0.1:${port}/hook/opencode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
      body: JSON.stringify({
        paneKey,
        tabId: paneKey.split(':')[0],
        worktreeId: 'folder::same-folder',
        opencodeTui: 1,
        launchToken: authority.get(paneKey),
        payload: { hook_event_name: hookEventName, sessionID },
        ...extra
      })
    })
    expect(response.status).toBe(204)
  }

  it('keeps overlapping pane statuses independent through forwarding and replay', async () => {
    await post(PANE_A, 'ses_a')
    await post(PANE_B, 'ses_b')
    forward.mockClear()
    await post(PANE_A, 'ses_b', 'SessionIdle', { opencodeTui: undefined, opencodeSharedServer: 1 })
    expect(forward).not.toHaveBeenCalled()
    await post(PANE_B, 'ses_b', 'SessionIdle')
    expect(forward.mock.calls[0][0]).toMatchObject({
      paneKey: PANE_B,
      payload: { state: 'done' }
    })
    forward.mockClear()
    expect(server.replayCachedPayloadsForPanes()).toBe(2)
    expect(forward.mock.calls.map(([event]) => [event.paneKey, event.payload.state])).toEqual([
      [PANE_A, 'working'],
      [PANE_B, 'done']
    ])
  })

  it('keeps the session creator when another pane views the same session', async () => {
    await post(PANE_A, 'ses_a')
    forward.mockClear()
    await post(PANE_B, 'ses_a')
    expect(forward.mock.calls[0][0].paneKey).toBe(PANE_A)
    expect(server.replayCachedPayloadsForPanes()).toBe(1)
  })

  it.each(['SessionIdle', 'PermissionRequest', 'MessagePart'] as const)(
    'rejects a retired physical viewer before attributing its late %s to a live creator',
    async (hookEventName) => {
      authority.set(PANE_B, 'creator-live')
      authority.set(PANE_C, 'viewer-old')
      await post(PANE_B, 'ses_b', 'SessionBusy', { launchToken: 'creator-live' })
      await post(PANE_C, 'ses_c', 'SessionBusy', { launchToken: 'viewer-old' })
      retired.add(PANE_C)
      server.clearPaneState(PANE_C)
      forward.mockClear()
      await post(PANE_C, 'ses_b', hookEventName, {
        launchToken: 'viewer-old',
        payload: {
          hook_event_name: hookEventName,
          sessionID: 'ses_b',
          role: 'assistant',
          text: 'late viewer text',
          permission: 'bash',
          requestID: 'late-request'
        }
      })
      expect(forward).not.toHaveBeenCalled()
      expect(server.replayCachedPayloadsForPanes()).toBe(1)
      expect(forward.mock.calls[0][0]).toMatchObject({
        paneKey: PANE_B,
        launchToken: 'creator-live',
        payload: { state: 'working' }
      })
      retired.delete(PANE_C)
      authority.set(PANE_C, 'viewer-new')
      forward.mockClear()
      await post(PANE_C, 'ses_b', 'SessionIdle', { launchToken: 'viewer-new' })
      expect(forward.mock.calls[0][0]).toMatchObject({
        paneKey: PANE_B,
        launchToken: 'creator-live',
        payload: { state: 'done' }
      })
    }
  )

  it.each(['SessionIdle', 'PermissionRequest', 'MessagePart'] as const)(
    'rejects a replaced physical viewer before borrowing the creator token for %s',
    async (hookEventName) => {
      authority.set(PANE_B, 'creator-live')
      authority.set(PANE_C, 'viewer-old')
      await post(PANE_B, 'ses_b')
      await post(PANE_C, 'ses_c')
      retired.add(PANE_C)
      server.clearPaneState(PANE_C)
      authority.set(PANE_C, 'viewer-new')
      retired.delete(PANE_C)
      forward.mockClear()
      for (const launchToken of ['viewer-old', undefined, '']) {
        await post(PANE_C, 'ses_b', hookEventName, {
          launchToken,
          payload: {
            hook_event_name: hookEventName,
            sessionID: 'ses_b',
            role: 'assistant',
            text: 'late',
            permission: 'bash'
          }
        })
      }
      expect(forward).not.toHaveBeenCalled()
      await post(PANE_C, 'ses_b', hookEventName)
      expect(forward.mock.calls[0][0]).toMatchObject({
        paneKey: PANE_B,
        launchToken: 'creator-live'
      })
    }
  )

  it('preserves the physical viewer when no host token can be verified', async () => {
    await post(PANE_B, 'ses_b')
    authority.delete(PANE_C)
    forward.mockClear()
    await post(PANE_C, 'ses_b', 'SessionIdle', { launchToken: 'viewer-old' })
    expect(forward.mock.calls[0][0]).toMatchObject({ paneKey: PANE_C, launchToken: 'viewer-old' })
  })

  it('does not let an unverifiable viewer create ownership later borrowed by a verified creator', async () => {
    authority.delete(PANE_C)
    await post(PANE_C, 'ses_unknown', 'SessionBusy', { launchToken: 'unknown-old' })
    forward.mockClear()
    await post(PANE_B, 'ses_unknown')
    expect(forward.mock.calls[0][0]).toMatchObject({ paneKey: PANE_B, launchToken: 'live-token' })
    forward.mockClear()
    await post(PANE_C, 'ses_unknown', 'SessionIdle', { launchToken: 'unknown-old' })
    expect(forward.mock.calls[0][0]).toMatchObject({ paneKey: PANE_C, launchToken: 'unknown-old' })
  })

  it('fences real spool replay before borrowing owner identity and retains legacy metadata', () => {
    const state = createHookListenerState()
    bindOpenCodeSession(state, 'ses_b', { paneKey: PANE_B, boundAt: 1, basis: 'tui' })
    trackOpenCodePaneLaunchToken(state, PANE_B, 'creator-live')
    authority.set(PANE_C, 'viewer-new')
    const spool = join(dir, 'spool')
    mkdirSync(spool)
    const file = join(spool, 'viewer.jsonl')
    const record = {
      paneKey: PANE_C,
      source: 'opencode',
      launchToken: 'viewer-old',
      opencodeTui: 1,
      receivedAt: Date.now(),
      payload: { hook_event_name: 'SessionIdle', sessionID: 'ses_b' }
    }
    const writeRecord = (value: unknown) => writeFileSync(file, `${JSON.stringify(value)}\n`)
    const host: Parameters<typeof ingestRelayHookSpoolRecord>[3] = {
      apply: (event, source, env, version) =>
        forward(buildRelayHookEnvelope(event, source, env, version)),
      isPaneSurfaceRetired: (paneKey: string) => retired.has(paneKey),
      getAgentLaunchToken: (paneKey: string) => authority.get(paneKey)
    }
    const drain = () =>
      drainAgentHookSpool({
        endpointDir: dir,
        getPersistedLaunchTokenHash: () => undefined,
        ingest: (item) => ingestRelayHookSpoolRecord(item, state, 'remote', host)
      })
    for (const launchToken of ['viewer-old', undefined, '']) {
      writeRecord({ ...record, launchToken })
      expect(drain()).toBe(1)
      expect(readFileSync(file).length).toBe(0)
    }
    expect(forward).not.toHaveBeenCalled()
    writeRecord({ ...record, launchToken: 'viewer-new' })
    drain()
    expect(forward.mock.calls[0][0]).toMatchObject({ paneKey: PANE_B, launchToken: 'creator-live' })
    forward.mockClear()
    writeRecord({
      ...record,
      opencodeTui: undefined,
      opencodeSharedServer: 1,
      payload: { hook_event_name: 'SessionIdle', sessionID: 'ses_unknown' }
    })
    drain()
    expect(forward).not.toHaveBeenCalled()
    writeRecord({ ...record, opencodeMajor: 2 })
    drain()
    expect(forward.mock.calls[0][0]).toMatchObject({ paneKey: PANE_C, launchToken: 'viewer-old' })
  })

  it('learns no identity from a rejected retired surface and admits its replacement', async () => {
    retired.add(PANE_B)
    await post(PANE_B, 'ses_old')
    expect(forward).not.toHaveBeenCalled()
    retired.delete(PANE_B)
    await post(PANE_A, 'ses_old', 'SessionIdle', {
      opencodeTui: undefined,
      opencodeSharedServer: 1
    })
    expect(forward).not.toHaveBeenCalled()
    await post(PANE_B, 'ses_new')
    expect(forward.mock.calls[0][0].paneKey).toBe(PANE_B)
    retired.add(PANE_B)
    server.clearPaneState(PANE_B)
    await post(PANE_B, 'ses_new', 'SessionIdle')
    forward.mockClear()
    expect(server.replayCachedPayloadsForPanes()).toBe(0)
    retired.delete(PANE_B)
    await post(PANE_B, 'ses_rebound')
    expect(forward.mock.calls[0][0]).toMatchObject({
      paneKey: PANE_B,
      providerSession: { id: 'ses_rebound' },
      payload: { state: 'working' }
    })
  })
})
