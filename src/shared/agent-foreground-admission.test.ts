import { describe, expect, it } from 'vitest'
import { canAdmitAgentForeground } from './agent-foreground-admission'
import { ownerDoubtFromHook, transitionHookPresence } from './agent-hook-presence-transition'
import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'

const scope = { connectionId: null, worktreeId: 'folder' }
const presence = {
  agent: 'codex',
  process: { pid: 42, platform: 'linux', startTime: 'boot:1' }
} as const
const other = { ...presence, process: { ...presence.process, startTime: 'boot:2' } }
const turn: AgentHookEventPayload = {
  paneKey: 'pane',
  ...scope,
  payload: { state: 'waiting', prompt: 'approve this', agentType: 'codex' }
}

describe('foreground admission into the sole owner store', () => {
  it('admits a verified process into a pane with no owner', () => {
    expect(canAdmitAgentForeground(undefined, presence, scope)).toBe(true)
    expect(canAdmitAgentForeground({ ...scope }, presence, scope)).toBe(true)
    expect(canAdmitAgentForeground(undefined, { agent: 'codex' }, scope)).toBe(false)
    expect(canAdmitAgentForeground(undefined, { ...presence, ended: true }, scope)).toBe(false)
  })
  it('never replaces a running owner, even when the same brand has another process', () => {
    const recorded = { ...scope, presence }
    expect(canAdmitAgentForeground(recorded, other, scope)).toBe(false)
    expect(canAdmitAgentForeground(recorded, presence, scope)).toBe(false)
  })
  it('lets a verified foreground process replace an owner proven stopped', () => {
    expect(canAdmitAgentForeground({ ...scope, presence }, other, scope, true)).toBe(true)
    expect(canAdmitAgentForeground({ ...scope, presence }, presence, scope, true)).toBe(false)
  })
  it('accepts a successor only after proven exit and refuses another host or workspace', () => {
    const recorded = { ...scope, presence: { ...presence, ended: true as const } }
    expect(canAdmitAgentForeground(recorded, other, scope)).toBe(true)
    expect(canAdmitAgentForeground(recorded, presence, scope)).toBe(false)
    expect(canAdmitAgentForeground(recorded, other, { ...scope, connectionId: 'ssh' })).toBe(false)
    expect(canAdmitAgentForeground(recorded, other, { ...scope, worktreeId: 'other' })).toBe(false)
  })
  it('hooks cannot create, replace or end process ownership on the relay cache', () => {
    const forged = { ...turn, agentPresence: { ...presence, ended: true as const } }
    expect(transitionHookPresence(forged, undefined)?.agentPresence).toBeUndefined()
    expect(
      transitionHookPresence(forged, { ...turn, agentPresence: presence })?.agentPresence
    ).toBe(presence)
  })
  it('lets every agent report after its pane owner exited, whatever its event table says', () => {
    const ended = { ...turn, agentPresence: { ...presence, ended: true as const } }
    for (const source of ['command-code', 'mimo-code', 'gemini', 'claude'] as const) {
      const hook = { ...turn, source, hookEventName: 'PreToolUse' }
      expect(transitionHookPresence(hook, ended)).toMatchObject({ hookEventName: 'PreToolUse' })
      expect(transitionHookPresence(hook, ended)?.agentPresence).toBeUndefined()
      expect(transitionHookPresence({ ...hook, isReplay: true }, ended)).toBeUndefined()
    }
  })
  it('doubts a live owner on idle or exit hooks only', () => {
    expect(ownerDoubtFromHook({ ...turn, hookEventName: 'Stop' }, presence)).toBe(true)
    expect(
      ownerDoubtFromHook({ ...turn, payload: { ...turn.payload, state: 'working' } }, presence)
    ).toBe(false)
    expect(ownerDoubtFromHook(turn, { ...presence, ended: true })).toBe(false)
    expect(ownerDoubtFromHook(turn, undefined)).toBe(false)
  })
})
