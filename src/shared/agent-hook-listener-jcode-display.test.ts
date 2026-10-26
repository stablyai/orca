import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareJcodeHookPayload } from './agent-hook-listener'
import { normalizeAndAccept, PANE_KEY as rootPane } from './agent-hook-listener-test-harness'
import {
  clearAllListenerCaches,
  clearPaneCacheState,
  createHookListenerState,
  movePaneCacheState,
  paneHasStateClaims,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import {
  bindJcodeRootSession,
  closeJcodeSession
} from './agent-hook-listener/jcode-session-registry'
import {
  bindJcodeDisplaySession,
  clearJcodeDisplayBindingsOfRoot,
  closeJcodeSessionTab,
  confirmJcodeSessionTab,
  findJcodeSessionOwner,
  jcodeDisplayPanesOfRoot,
  jcodePaneRetirementState,
  lookupJcodeDisplayBinding,
  releaseJcodeSessionTab,
  reserveJcodeSessionTab,
  resolveJcodeDisplayEnvelope,
  settleJcodeDisplayPane,
  type JcodeDisplayBinding
} from './agent-hook-listener/jcode-display-registry'
import {
  bonehoundHooks,
  childPane,
  displayMetadata,
  displayRootId,
  displayWorkerId,
  movedPane,
  pawprintStart,
  pigletLateTool,
  pigletStart,
  pigletTurn,
  throwawayId
} from './agent-hook-listener-jcode-display-fixtures'
import {
  rootMetadata,
  tigressHooks,
  workerMetadata
} from './agent-hook-listener-jcode-swarm-fixtures'

describe('Jcode display ownership and prepared ingress', () => {
  let home: string
  let state: HookListenerState
  let binding: JcodeDisplayBinding
  const owner = () => ({
    sessionId: displayWorkerId,
    paneKey: childPane,
    kind: 'worker' as const,
    rootPaneKey: rootPane
  })
  const accept = (payload: Record<string, unknown>) => normalizeAndAccept(state, 'jcode', payload)
  function bind() {
    expect(reserveJcodeSessionTab(state, owner())).toEqual({ ok: true })
    expect(bindJcodeDisplaySession(state, binding)).toBe(true)
  }
  function rootTurn() {
    accept(pawprintStart)
    // Negative control: captured turn shape attributed to root with distinct prompt/model.
    accept({
      ...pigletTurn,
      session_id: displayRootId,
      model: 'claude-opus-5-5',
      prompt: 'Root request'
    })
  }
  function snapshot() {
    return structuredClone({ ...state, lastStatusByPaneKey: new Map(state.lastStatusByPaneKey) })
  }
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'jcode-display-'))
    mkdirSync(join(home, 'sessions'))
    vi.stubEnv('JCODE_HOME', home)
    for (const metadata of [...displayMetadata, rootMetadata, workerMetadata]) {
      writeFileSync(join(home, 'sessions', `${metadata.id}.json`), JSON.stringify(metadata))
    }
    state = createHookListenerState()
    binding = {
      rootPaneKey: rootPane,
      displayPaneKey: childPane,
      sessionId: displayWorkerId,
      coordinatorSessionId: displayRootId,
      tabId: 'tab-child',
      worktreeId: 'child-worktree',
      launchToken: randomUUID(),
      state: 'open',
      boundAt: 1_000
    }
    expect(bindJcodeRootSession(state, rootPane, displayRootId, 'launch')).toBe(true)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  it('reads retirement ownership and bindings without changing listener state', () => {
    bind()
    confirmJcodeSessionTab(state, displayWorkerId, childPane)
    reserveJcodeSessionTab(state, { ...owner(), sessionId: 'creating-worker', paneKey: movedPane })
    const before = snapshot()
    expect(jcodePaneRetirementState(state, rootPane)).toEqual({
      openChildren: new Set([childPane]),
      hasOwner: false,
      hasBinding: false,
      hasRootBindings: true
    })
    expect(jcodePaneRetirementState(state, childPane)).toEqual({
      openChildren: new Set([childPane]),
      hasOwner: true,
      hasBinding: true,
      hasRootBindings: false
    })
    expect(jcodePaneRetirementState(state, movedPane)).toEqual({
      openChildren: new Set([childPane]),
      hasOwner: true,
      hasBinding: false,
      hasRootBindings: false
    })
    expect(jcodePaneRetirementState(state, 'unknown')).toEqual({
      openChildren: new Set([childPane]),
      hasOwner: false,
      hasBinding: false,
      hasRootBindings: false
    })
    expect(snapshot()).toEqual(before)
  })

  it('reserves each worker once, confirms it, and releases only its own pane', () => {
    expect(reserveJcodeSessionTab(state, owner())).toEqual({ ok: true })
    expect(reserveJcodeSessionTab(state, { ...owner(), paneKey: movedPane })).toEqual({
      ok: false,
      owner: { ...owner(), state: 'creating' }
    })
    expect(findJcodeSessionOwner(state, displayWorkerId)).toEqual({
      paneKey: childPane,
      role: 'worker',
      state: 'creating'
    })
    expect(confirmJcodeSessionTab(state, displayWorkerId, movedPane)).toBe(false)
    expect(confirmJcodeSessionTab(state, displayWorkerId, childPane)).toBe(true)
    expect(reserveJcodeSessionTab(state, owner())).toMatchObject({
      ok: false,
      owner: { state: 'open' }
    })
    releaseJcodeSessionTab(state, displayWorkerId, movedPane)
    expect(findJcodeSessionOwner(state, displayWorkerId)?.state).toBe('open')
    releaseJcodeSessionTab(state, displayWorkerId, childPane)
    expect(findJcodeSessionOwner(state, displayWorkerId)).toBeUndefined()
    expect(reserveJcodeSessionTab(state, owner())).toEqual({ ok: true })
  })

  it('finds roots and plain tabs, and refuses to reserve an already bound root', () => {
    expect(
      reserveJcodeSessionTab(state, { ...owner(), sessionId: displayRootId, kind: 'plain' })
    ).toMatchObject({
      ok: false,
      owner: { paneKey: rootPane, sessionId: displayRootId, state: 'open' }
    })
    expect(findJcodeSessionOwner(state, displayRootId)).toEqual({
      paneKey: rootPane,
      role: 'root',
      state: 'open'
    })
    expect(reserveJcodeSessionTab(state, { ...owner(), kind: 'plain' })).toEqual({ ok: true })
    expect(findJcodeSessionOwner(state, displayWorkerId)?.role).toBe('plain')
    expect(closeJcodeSessionTab(state, childPane)).toEqual([displayWorkerId])
    expect(closeJcodeSessionTab(state, childPane)).toEqual([])
    expect(findJcodeSessionOwner(state, displayWorkerId)).toBeUndefined()
    expect(paneHasStateClaims(state, childPane)).toBe(false)
  })

  it('refuses confirmation after destination retirement without recreating ownership', () => {
    bind()
    expect(closeJcodeSessionTab(state, childPane)).toEqual([displayWorkerId])
    expect(findJcodeSessionOwner(state, displayWorkerId)).toBeUndefined()
    expect(confirmJcodeSessionTab(state, displayWorkerId, childPane)).toBe(false)
    expect(state.jcodeTabOwners.size).toBe(0)
  })

  it('binds only the reserved worker pane under its bound coordinator', () => {
    const before = snapshot()
    expect(bindJcodeDisplaySession(state, binding)).toBe(false)
    expect(snapshot()).toEqual(before)
    reserveJcodeSessionTab(state, { ...owner(), kind: 'plain' })
    expect(bindJcodeDisplaySession(state, binding)).toBe(false)
    releaseJcodeSessionTab(state, displayWorkerId, childPane)
    reserveJcodeSessionTab(state, owner())
    for (const invalid of [
      { ...binding, coordinatorSessionId: 'foreign-coordinator' },
      { ...binding, displayPaneKey: movedPane }
    ]) {
      expect(bindJcodeDisplaySession(state, invalid)).toBe(false)
    }
    expect(state.jcodeDisplayBindings.size).toBe(0)
    expect(state.jcodeSessions.roots.has(childPane)).toBe(false)
    expect(bindJcodeDisplaySession(state, binding)).toBe(true)
    expect(state.jcodeSessions.roots.get(childPane)).toBe(displayWorkerId)
    expect(jcodeDisplayPanesOfRoot(state, rootPane)).toEqual([childPane])
  })

  it('routes captured Piglet turn to child without changing root row, caches or roster', () => {
    rootTurn()
    const rootRow = state.lastStatusByPaneKey.get(rootPane)
    const rootPayload = state.jcodeRootPayloadByPaneKey.get(rootPane)
    const rootTurnState = state.jcodeTurnByPaneKey.get(rootPane)
    bind()
    const before = snapshot()
    const body = {
      paneKey: rootPane,
      tabId: 'tab-1',
      worktreeId: 'root-worktree',
      launchToken: randomUUID(),
      payload: pigletTurn
    }
    const prepared = prepareJcodeHookPayload(state, body, 'production')
    expect(snapshot()).toEqual(before)
    expect(prepared?.admission.paneKey).toBe(childPane)
    expect(prepared?.admission.worktreeId).toBe('child-worktree')
    expect(prepared?.admission.launchToken === binding.launchToken).toBe(true)
    expect(prepared?.event).toMatchObject({
      paneKey: childPane,
      tabId: 'tab-child',
      providerSession: { key: 'session_id', id: displayWorkerId },
      payload: { state: 'working', model: 'claude-haiku-5-5' }
    })
    const event = accept(pigletTurn)
    expect(event?.paneKey).toBe(childPane)
    expect(state.lastStatusByPaneKey.get(childPane)?.payload.state).toBe('working')
    expect(state.lastStatusByPaneKey.get(rootPane)).toBe(rootRow)
    expect(state.jcodeRootPayloadByPaneKey.get(rootPane)).toBe(rootPayload)
    expect(state.jcodeTurnByPaneKey.get(rootPane)).toBe(rootTurnState)
    expect(state.jcodeSessions.roots.get(rootPane)).toBe(displayRootId)
    expect(state.jcodeSubagentRosterByPaneKey.get(rootPane)?.has(displayWorkerId) ?? false).toBe(
      false
    )
    expect(body.paneKey).toBe(rootPane)
  })

  it('uses only display envelope metadata, including absent worktree and launch identity', () => {
    binding = { ...binding, tabId: 'stale-tab', worktreeId: undefined, launchToken: undefined }
    bind()
    expect(
      resolveJcodeDisplayEnvelope({
        state,
        stamped: {
          paneKey: rootPane,
          tabId: 'tab-1',
          worktreeId: 'root-worktree',
          launchToken: randomUUID()
        },
        sessionId: displayWorkerId
      })
    ).toEqual({
      kind: 'route',
      envelope: {
        paneKey: childPane,
        tabId: 'tab-child',
        worktreeId: undefined,
        launchToken: undefined
      }
    })
    expect(
      resolveJcodeDisplayEnvelope({
        state,
        stamped: { paneKey: movedPane },
        sessionId: displayWorkerId
      })
    ).toEqual({ kind: 'pass' })
    expect(
      resolveJcodeDisplayEnvelope({ state, stamped: { paneKey: rootPane }, sessionId: undefined })
    ).toEqual({ kind: 'pass' })
  })

  it('negative control: parentless worker arriving before bind produces no row', () => {
    expect(accept(pigletTurn)).toBeNull()
    expect(state.lastStatusByPaneKey.size).toBe(0)
    expect(state.jcodeSessions.pending).toEqual([])
    expect(state.jcodeDisplayBindings.size).toBe(0)
  })

  it('ignores captured throwaway create/close without binding, row or resume identity', () => {
    for (const payload of bonehoundHooks) {
      expect(accept(payload)).toBeNull()
    }
    expect(state.lastStatusByPaneKey.size).toBe(0)
    expect(findJcodeSessionOwner(state, throwawayId)).toBeUndefined()
    expect(lookupJcodeDisplayBinding(state, rootPane, throwawayId)).toBeUndefined()
    expect([...state.jcodeSessions.roots.values()]).toEqual([displayRootId])
    expect(state.jcodeSessions.pending).toEqual([])
    expect(state.jcodeSessions.resumes.has(`${rootPane}\0${throwawayId}`)).toBe(false)
  })

  it('settles display root and drops captured late tool without changing either pane', () => {
    rootTurn()
    bind()
    accept(pigletStart)
    accept(pigletTurn)
    expect(settleJcodeDisplayPane(state, childPane)).toBe(true)
    expect(confirmJcodeSessionTab(state, displayWorkerId, childPane)).toBe(false)
    expect(lookupJcodeDisplayBinding(state, rootPane, displayWorkerId)?.state).toBe('closed')
    expect(state.jcodeSessions.roots.has(childPane)).toBe(false)
    expect(jcodeDisplayPanesOfRoot(state, rootPane)).toEqual([])
    expect(findJcodeSessionOwner(state, displayWorkerId)).toBeUndefined()
    const before = snapshot()
    expect(
      prepareJcodeHookPayload(state, { paneKey: rootPane, payload: pigletLateTool }, 'production')
    ).toBeNull()
    expect(accept(pigletLateTool)).toBeNull()
    expect(snapshot()).toEqual(before)
    expect(settleJcodeDisplayPane(state, movedPane)).toBe(false)
  })

  it('retains closed worker routing tombstone when ownership is freed for plain resume', () => {
    bind()
    settleJcodeDisplayPane(state, childPane)
    expect(closeJcodeSessionTab(state, childPane)).toEqual([displayWorkerId])
    expect(
      reserveJcodeSessionTab(state, { ...owner(), paneKey: movedPane, kind: 'plain' })
    ).toEqual({ ok: true })
    expect(findJcodeSessionOwner(state, displayWorkerId)).toEqual({
      paneKey: movedPane,
      role: 'plain',
      state: 'creating'
    })
    expect(accept(pigletLateTool)).toBeNull()
    expect(lookupJcodeDisplayBinding(state, rootPane, displayWorkerId)?.state).toBe('closed')
  })

  it('release preserves settled routing tombstone and keeps late events dropped', () => {
    bind()
    settleJcodeDisplayPane(state, childPane)
    releaseJcodeSessionTab(state, displayWorkerId, childPane)
    clearPaneCacheState(state, rootPane)
    expect(
      resolveJcodeDisplayEnvelope({
        state,
        stamped: { paneKey: rootPane },
        sessionId: displayWorkerId
      })
    ).toEqual({ kind: 'drop' })
    expect(accept(pigletLateTool)).toBeNull()
    expect(state.lastStatusByPaneKey.size).toBe(0)
    expect(state.jcodeSessions.roots.has(rootPane)).toBe(false)
    expect(lookupJcodeDisplayBinding(state, rootPane, displayWorkerId)?.state).toBe('closed')
    expect(findJcodeSessionOwner(state, displayWorkerId)).toBeUndefined()
  })

  it('releases failed creation binding without touching another pane reservation', () => {
    bind()
    releaseJcodeSessionTab(state, displayWorkerId, movedPane)
    expect(lookupJcodeDisplayBinding(state, rootPane, displayWorkerId)?.state).toBe('open')
    releaseJcodeSessionTab(state, displayWorkerId, childPane)
    expect(lookupJcodeDisplayBinding(state, rootPane, displayWorkerId)).toBeUndefined()
    expect(findJcodeSessionOwner(state, displayWorkerId)).toBeUndefined()
    expect(confirmJcodeSessionTab(state, displayWorkerId, childPane)).toBe(false)
  })

  it('keeps inline workers on the root roster with no display binding', () => {
    state = createHookListenerState()
    accept(tigressHooks[0])
    // Negative control: captured worker turn starts the root before inline worker activity.
    accept({ ...tigressHooks[4], session_id: rootMetadata.id })
    const event = accept(tigressHooks[4])
    expect(event).toMatchObject({
      paneKey: rootPane,
      providerSession: { id: rootMetadata.id },
      payload: { subagents: [{ id: workerMetadata.id, state: 'working' }] }
    })
    expect(state.jcodeDisplayBindings.size).toBe(0)
  })

  it('keeps root resume evidence when display launch binding clears child evidence', () => {
    closeJcodeSession(state, rootPane, 'retired-root')
    state.jcodeSessions.resumes.set(`${rootPane}\0retired-root`, Date.now())
    closeJcodeSession(state, childPane, displayWorkerId)
    state.jcodeSessions.resumes.set(`${childPane}\0${displayWorkerId}`, Date.now())
    const rootResumes = [...state.jcodeSessions.resumes].filter(([key]) =>
      key.startsWith(`${rootPane}\0`)
    )
    bind()
    expect([...state.jcodeSessions.resumes]).toEqual(rootResumes)
  })

  it('agent-only cleanup preserves display ownership; global cleanup drops it', () => {
    rootTurn()
    bind()
    clearPaneCacheState(state, rootPane)
    expect(state.jcodeSessions.roots.has(rootPane)).toBe(false)
    expect(state.lastStatusByPaneKey.has(rootPane)).toBe(false)
    expect(paneHasStateClaims(state, rootPane)).toBe(false)
    expect(findJcodeSessionOwner(state, displayWorkerId)?.state).toBe('creating')
    expect(lookupJcodeDisplayBinding(state, rootPane, displayWorkerId)?.state).toBe('open')
    clearPaneCacheState(state, childPane)
    expect(paneHasStateClaims(state, childPane)).toBe(false)
    expect(state.jcodeTabOwners.size).toBe(1)
    expect(state.jcodeDisplayBindings.size).toBe(1)
    clearAllListenerCaches(state)
    expect(state.jcodeTabOwners.size).toBe(0)
    expect(state.jcodeDisplayBindings.size).toBe(0)
  })

  it('moves root and child identities consistently, including binding-derived tab id', () => {
    bind()
    movePaneCacheState(state, rootPane, movedPane)
    expect(state.jcodeSessions.roots.get(movedPane)).toBe(displayRootId)
    expect(lookupJcodeDisplayBinding(state, rootPane, displayWorkerId)).toBeUndefined()
    expect(lookupJcodeDisplayBinding(state, movedPane, displayWorkerId)?.rootPaneKey).toBe(
      movedPane
    )
    expect(state.jcodeTabOwners.get(displayWorkerId)?.rootPaneKey).toBe(movedPane)
    movePaneCacheState(state, childPane, rootPane)
    expect(state.jcodeSessions.roots.get(rootPane)).toBe(displayWorkerId)
    expect(state.jcodeTabOwners.get(displayWorkerId)?.paneKey).toBe(rootPane)
    expect(lookupJcodeDisplayBinding(state, movedPane, displayWorkerId)).toMatchObject({
      displayPaneKey: rootPane,
      tabId: 'tab-1'
    })
  })

  it('clears only one root display family, including unbound creating reservations', () => {
    bind()
    reserveJcodeSessionTab(state, { ...owner(), sessionId: 'creating-worker', paneKey: movedPane })
    reserveJcodeSessionTab(state, {
      ...owner(),
      sessionId: 'other-worker',
      paneKey: movedPane,
      rootPaneKey: movedPane
    })
    expect(jcodeDisplayPanesOfRoot(state, rootPane)).toEqual([childPane, movedPane])
    clearJcodeDisplayBindingsOfRoot(state, rootPane)
    expect(jcodeDisplayPanesOfRoot(state, rootPane)).toEqual([])
    expect(state.jcodeDisplayBindings.size).toBe(0)
    expect(findJcodeSessionOwner(state, displayWorkerId)).toBeUndefined()
    expect(findJcodeSessionOwner(state, 'creating-worker')).toBeUndefined()
    expect(findJcodeSessionOwner(state, 'other-worker')?.paneKey).toBe(movedPane)
    expect(state.jcodeSessions.roots.has(childPane)).toBe(false)
  })

  it('caps owners without evicting live tabs and reclaims closed entries first', () => {
    bind()
    settleJcodeDisplayPane(state, childPane)
    for (let index = 0; index < 255; index++) {
      expect(
        reserveJcodeSessionTab(state, { ...owner(), sessionId: `plain-${index}`, kind: 'plain' })
      ).toEqual({ ok: true })
    }
    expect(
      reserveJcodeSessionTab(state, { ...owner(), sessionId: 'last-owner', kind: 'plain' })
    ).toEqual({ ok: true })
    expect(state.jcodeTabOwners.size).toBe(256)
    expect(state.jcodeTabOwners.has(displayWorkerId)).toBe(false)
    expect(
      reserveJcodeSessionTab(state, { ...owner(), sessionId: 'over-cap', kind: 'plain' })
    ).toEqual({
      ok: false,
      owner: { ...owner(), sessionId: 'over-cap', kind: 'plain', state: 'closed' }
    })
    expect(state.jcodeTabOwners.has('over-cap')).toBe(false)
    expect(findJcodeSessionOwner(state, 'over-cap')).toBeUndefined()
    expect(findJcodeSessionOwner(state, 'plain-0')?.state).toBe('creating')
    expect(state.jcodeTabOwners.size).toBe(256)
  })

  it('caps display bindings, evicts closed first, and never binds child on refusal', () => {
    for (let index = 0; index < 256; index++) {
      const sessionId = `worker-${index}`
      const displayPaneKey = `tab-${index}:22222222-2222-4222-8222-222222222222`
      reserveJcodeSessionTab(state, { ...owner(), sessionId, paneKey: displayPaneKey })
      expect(bindJcodeDisplaySession(state, { ...binding, sessionId, displayPaneKey })).toBe(true)
      confirmJcodeSessionTab(state, sessionId, displayPaneKey)
    }
    // Free an owner without evicting its live routing entry: isolate the binding cap.
    state.jcodeTabOwners.delete('worker-255')
    reserveJcodeSessionTab(state, owner())
    const before = snapshot()
    expect(bindJcodeDisplaySession(state, binding)).toBe(false)
    expect(snapshot()).toEqual(before)
    settleJcodeDisplayPane(state, 'tab-0:22222222-2222-4222-8222-222222222222')
    expect(bindJcodeDisplaySession(state, binding)).toBe(true)
    expect(state.jcodeDisplayBindings.size).toBe(256)
    expect(lookupJcodeDisplayBinding(state, rootPane, 'worker-0')).toBeUndefined()
  })
})
