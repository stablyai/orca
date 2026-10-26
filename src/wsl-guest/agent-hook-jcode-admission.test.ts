import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createHookListenerState,
  clearPaneCacheState,
  seedLegacyAgentStatusForTests,
  type HookListenerState
} from '../shared/agent-hook-listener/listener-state'
import { prepareJcodeRootSettlement } from '../shared/agent-hook-listener'
import {
  rootMetadata,
  workerMetadata,
  tigressHooks
} from '../shared/agent-hook-listener-jcode-swarm-fixtures'
import { buildBody, PANE } from '../main/agent-hooks/server.test-fixtures'
import { ingestRelayJcodeHook } from './agent-hook-jcode-ingress'
import { RelayProviderHookNormalization } from './agent-hook-provider-normalization'
import { applyRelayHookEvent } from './agent-hook-event-admission'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import type { CachedPaneEnvelopeMeta } from './agent-hook-cached-pane-status'
import { MAX_CACHED_PANES } from './agent-hook-cached-pane-status'
import { bindJcodeRootSession } from '../shared/agent-hook-listener/jcode-session-registry'

describe('Jcode relay prepared admission', () => {
  let dir: string
  let state: HookListenerState
  let refuseCache: boolean
  let normalization: RelayProviderHookNormalization
  let metadata: Map<string, CachedPaneEnvelopeMeta>
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jcode-relay-admission-'))
    vi.stubEnv('JCODE_HOME', dir)
    mkdirSync(join(dir, 'sessions'))
    for (const value of [rootMetadata, workerMetadata]) {
      writeFileSync(join(dir, 'sessions', `${value.id}.json`), JSON.stringify(value))
    }
    refuseCache = false
    state = createHookListenerState({ isCanonicalPaneKey: () => refuseCache })
    normalization = new RelayProviderHookNormalization()
    metadata = new Map()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  })
  function apply(event: AgentHookEventPayload, onCommitted?: () => void) {
    return applyRelayHookEvent(
      {
        state,
        metadata,
        isCanonicalPane: () => false,
        isPaneSurfaceRetired: () => false,
        clearPaneState: (paneKey) => {
          clearPaneCacheState(state, paneKey)
          normalization.clearPane(paneKey)
          metadata.delete(paneKey)
        },
        clearAssistantMessageRetry: () => {},
        forward: () => {},
        checkAgentPresence: async () => {}
      },
      event,
      'jcode',
      undefined,
      undefined,
      { onCommitted }
    )
  }
  function send(payload: Record<string, unknown>) {
    ingestRelayJcodeHook(
      state,
      'production',
      { body: buildBody(payload), receivedAt: Date.now() },
      {
        providerNormalization: normalization,
        isPaneSurfaceRetired: () => false,
        getAgentLaunchToken: () => undefined,
        apply: (event, _source, _env, _version, options) => apply(event, options?.onCommitted)
      }
    )
  }
  const start = () => ({ ...tigressHooks[0], event: 'turn_start', prompt: 'root prompt' })

  it('failed final cache admission commits no registry, roster, root or prompt state', () => {
    const before = structuredClone({
      ...state,
      lastStatusByPaneKey: new Map(state.lastStatusByPaneKey)
    })
    refuseCache = true
    send(start())
    expect(
      structuredClone({ ...state, lastStatusByPaneKey: new Map(state.lastStatusByPaneKey) })
    ).toEqual(before)
    refuseCache = false
    send(start())
    expect(state.jcodeSessions.roots.get(PANE)).toBe(rootMetadata.id)
    expect(state.lastStatusByPaneKey.get(PANE)?.payload.prompt).toBe('root prompt')
  })

  it('commits the new root after the 256-pane cache evicts another Jcode owner', () => {
    const oldest = `oldest:${PANE.split(':')[1]}`
    for (let index = 0; index < MAX_CACHED_PANES; index += 1) {
      seedLegacyAgentStatusForTests(state, {
        paneKey: index === 0 ? oldest : `cached-${index}:${PANE.split(':')[1]}`,
        connectionId: null,
        payload: { state: 'done', prompt: '', agentType: 'jcode' }
      })
    }
    expect(bindJcodeRootSession(state, oldest, 'evicted-root', 'launch')).toBe(true)
    expect(state.lastStatusByPaneKey.size).toBe(256)
    send(start())
    expect(state.lastStatusByPaneKey.size).toBe(256)
    expect(state.lastStatusByPaneKey.has(oldest)).toBe(false)
    expect(state.jcodeSessions.roots.has(oldest)).toBe(false)
    expect(
      Array.from(state.jcodeSessions.bindings.values()).some((entry) => entry.paneKey === oldest)
    ).toBe(false)
    expect(state.jcodeSessions.roots.get(PANE)).toBe(rootMetadata.id)
    expect(state.jcodeTurnByPaneKey.get(PANE)).toMatchObject({
      sessionId: rootMetadata.id,
      active: true
    })
    expect(state.jcodeRootPayloadByPaneKey.get(PANE)).toMatchObject({
      state: 'working',
      prompt: 'root prompt',
      mainAgent: { state: 'working' }
    })
    send(tigressHooks[1])
    expect(state.lastStatusByPaneKey.get(PANE)?.payload.toolName).toBe('bash')
  })

  it.each([false, true])(
    'cancel_settle_then_worker_event_keeps_root_done: active child=%s',
    (active) => {
      send(start())
      if (active) {
        send(tigressHooks[4])
      }
      const turn = state.jcodeTurnByPaneKey.get(PANE)
      if (!turn) {
        throw new Error('Expected root turn')
      }
      const prepared = prepareJcodeRootSettlement(state, PANE, rootMetadata.id, turn.revision)
      const row = state.lastStatusByPaneKey.get(PANE)
      if (!prepared || !row) {
        throw new Error('Expected settlement')
      }
      apply(
        {
          ...row,
          hookEventName: undefined,
          hasExplicitPrompt: undefined,
          payload: prepared.payload
        },
        prepared.commit
      )
      expect(state.lastStatusByPaneKey.get(PANE)?.payload).toMatchObject({
        state: active ? 'working' : 'done',
        mainAgent: { state: 'done' }
      })
      const settled = state.lastStatusByPaneKey.get(PANE)
      send(tigressHooks[1])
      expect(state.lastStatusByPaneKey.get(PANE)).toBe(settled)
      send(active ? tigressHooks[5] : tigressHooks[2])
      expect(state.lastStatusByPaneKey.get(PANE)).toMatchObject({
        providerSession: { id: rootMetadata.id },
        payload: {
          state: 'done',
          mainAgent: { state: 'done' },
          prompt: 'root prompt',
          model: start().model
        }
      })
    }
  )
})
