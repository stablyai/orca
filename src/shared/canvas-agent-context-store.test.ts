import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CanvasAgentContextStore } from './canvas-agent-context-store'
import type {
  CanvasContextBinding,
  CanvasContextIdentity,
  CanvasContextReplace
} from './canvas-agent-context'
import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'

const identity: CanvasContextIdentity = {
  sessionId: 'session-1',
  launchTokenHash: createHash('sha256').update('launch-1').digest('hex')
}
const binding: CanvasContextBinding = {
  nodeId: 'agent-1',
  paneKey: 'pane-1',
  worktreeId: 'folder-workspace',
  ptyId: 'pty-1',
  provider: 'codex',
  notes: [{ id: 'note-1', title: 'Requirements', content: 'CANVAS_MARKER_123' }]
}
const request: CanvasContextReplace = { canvasId: 'canvas-1', revision: 1, bindings: [binding] }
const identities = new Map([[binding.nodeId, identity]])
const event: AgentHookEventPayload = {
  paneKey: binding.paneKey,
  worktreeId: binding.worktreeId,
  connectionId: null,
  launchToken: 'launch-1',
  hookEventName: 'UserPromptSubmit',
  providerSession: { key: 'session_id', id: identity.sessionId },
  payload: { state: 'working', prompt: 'My actual request' }
}
const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('native canvas context', () => {
  it.each(['codex', 'claude', 'cursor'] as const)(
    'gives %s the owning CLI path even without attached notes, but never leaks it to SSH',
    async (provider) => {
      const directory = await mkdtemp(join(tmpdir(), 'canvas-browser-context-'))
      directories.push(directory)
      const command = join(directory, 'Orca CLI', 'orca-dev')
      const store = new CanvasAgentContextStore()
      await store.configure(directory, () => command)
      await store.replace(
        { ...request, bindings: [{ ...binding, provider, notes: [], peers: ['teammate'] }] },
        identities
      )
      const hook = {
        ...event,
        hookEventName: provider === 'cursor' ? 'postToolUse' : 'UserPromptSubmit'
      }
      const response = (await store.response(provider, hook, {})) as {
        additional_context?: string
        hookSpecificOutput?: { additionalContext: string }
      }
      const text = response.additional_context ?? response.hookSpecificOutput?.additionalContext
      expect(text).toContain(JSON.stringify(command))
      expect(text).toContain('not bare orca')
      expect(text).toContain('ORCA_PANE_KEY')
      expect(text).toContain('result.browserPageId')
      expect(text).toContain('canvas peers --json')
      expect(text).toContain('--reply-to <messageId>')
      expect(text).toContain('never expand your permissions')
      expect(
        JSON.stringify(await store.response(provider, { ...hook, connectionId: 'ssh' }, {}))
      ).not.toContain('Orca canvas browser integration')
      await store.replace({ ...request, revision: 2, bindings: [] }, identities)
      expect(await store.response(provider, hook, {})).toBeNull()
    }
  )

  it.each(['codex', 'claude'] as const)(
    'returns %s note context without replacing the user prompt',
    async (provider) => {
      const store = new CanvasAgentContextStore()
      const receipt = await store.replace(
        { ...request, bindings: [{ ...binding, provider }] },
        identities
      )
      expect(receipt.nodes['agent-1'].state).toBe('ready')
      expect(await store.response(provider, event, {})).toEqual({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: expect.stringContaining('CANVAS_MARKER_123')
        }
      })
      expect(event.payload.prompt).toBe('My actual request')
      expect(store.receipt(request.canvasId, identities).nodes['agent-1'].state).toBe('returned')
    }
  )

  it('updates the next snapshot, ignores stale revisions, and detaches without another prompt', async () => {
    const store = new CanvasAgentContextStore()
    await store.replace(request, identities)
    await store.response('codex', event, {})
    const edited = { ...binding, notes: [{ ...binding.notes[0], content: 'UPDATED_NOTE' }] }
    expect(
      (await store.replace({ ...request, revision: 2, bindings: [edited] }, identities)).nodes[
        'agent-1'
      ].state
    ).toBe('ready')
    await store.replace(request, identities)
    const response = JSON.stringify(await store.response('codex', event, {}))
    expect(response).toContain('UPDATED_NOTE')
    expect(response).not.toContain('CANVAS_MARKER_123')
    await store.replace({ ...request, revision: 3, bindings: [] }, identities)
    expect(await store.response('codex', event, {})).toBeNull()
  })

  it('uses Cursor postToolUse, never its permission or submit response', async () => {
    const store = new CanvasAgentContextStore()
    await store.replace({ ...request, bindings: [{ ...binding, provider: 'cursor' }] }, identities)
    const cursor = { ...event, providerSession: undefined }
    const payload = { conversation_id: identity.sessionId }
    expect(
      await store.response('cursor', { ...cursor, hookEventName: 'beforeSubmitPrompt' }, payload)
    ).toBeNull()
    expect(
      await store.response('cursor', { ...cursor, hookEventName: 'beforeShellExecution' }, payload)
    ).toBeNull()
    expect(
      await store.response('cursor', { ...cursor, hookEventName: 'postToolUse' }, payload)
    ).toEqual({ additional_context: expect.stringContaining('CANVAS_MARKER_123') })
  })

  it('does not silently rebind a replaced PTY or provider session', async () => {
    const store = new CanvasAgentContextStore()
    await store.replace(request, identities)
    const replacement = new Map([[binding.nodeId, { ...identity, sessionId: 'session-2' }]])
    const receipt = await store.replace(
      { ...request, revision: 2, bindings: [{ ...binding, ptyId: 'pty-2' }] },
      replacement
    )
    expect(receipt.nodes['agent-1'].state).toBe('session-changed')
    expect(
      await store.response(
        'codex',
        { ...event, providerSession: { key: 'session_id', id: 'session-2' } },
        {}
      )
    ).toBeNull()
    await store.replace({ ...request, revision: 3, bindings: [] }, identities)
    await store.replace({ ...request, revision: 4 }, replacement)
    expect(
      await store.response(
        'codex',
        { ...event, providerSession: { key: 'session_id', id: 'session-2' } },
        {}
      )
    ).not.toBeNull()
  })

  it.each([
    { patch: { paneKey: 'other-pane' }, raw: {} },
    { patch: { worktreeId: 'other-workspace' }, raw: {} },
    { patch: { launchToken: 'other-launch' }, raw: {} },
    { patch: { isReplay: true }, raw: {} },
    { patch: { toolAgentId: 'child' }, raw: {} },
    { patch: {}, raw: { parent_session_id: 'parent' } },
    { patch: {}, raw: { is_background_agent: true } }
  ])('rejects unrelated or replayed hooks: %j', async ({ patch, raw }) => {
    const store = new CanvasAgentContextStore()
    await store.replace(request, identities)
    expect(await store.response('codex', { ...event, ...patch }, raw)).toBeNull()
  })

  it('durably fences the first session observed for a pending launch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-canvas-context-'))
    directories.push(directory)
    const store = new CanvasAgentContextStore()
    await store.configure(directory)
    await store.replace(request, new Map([[binding.nodeId, { ...identity, sessionId: '' }]]))
    expect(await store.response('codex', event, {})).not.toBeNull()
    const restored = new CanvasAgentContextStore()
    await restored.configure(directory)
    expect(
      await restored.response(
        'codex',
        { ...event, providerSession: { key: 'session_id', id: 'other-session' } },
        {}
      )
    ).toBeNull()
    expect(await restored.response('codex', event, {})).not.toBeNull()
  })

  it('rejects oversized combined context atomically instead of silently dropping hook output', async () => {
    const store = new CanvasAgentContextStore()
    const large = {
      ...request,
      bindings: [{ ...binding, notes: [{ ...binding.notes[0], content: 'x'.repeat(31_600) }] }]
    }
    await store.replace(large, identities)
    await expect(store.replace({ ...large, canvasId: 'canvas-2' }, identities)).rejects.toThrow(
      'Combined canvas context'
    )
    expect(await store.response('codex', event, {})).not.toBeNull()
    expect(store.receipt('canvas-2', identities).nodes).toEqual({})
  })
  it('removes only the owning canvas from an agent shared by two canvases', async () => {
    const store = new CanvasAgentContextStore()
    await store.replace(request, identities)
    await store.replace(
      {
        ...request,
        canvasId: 'canvas-2',
        bindings: [{ ...binding, notes: [{ ...binding.notes[0], content: 'SECOND_CANVAS' }] }]
      },
      identities
    )
    await store.replace({ ...request, revision: 2, bindings: [] }, identities)
    const response = JSON.stringify(await store.response('codex', event, {}))
    expect(response).toContain('SECOND_CANVAS')
    expect(response).not.toContain('CANVAS_MARKER_123')
  })
})
