import { describe, expect, it } from 'vitest'
import { commandEndEndsRow } from './agent-command-end'
import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import type { CommandForeground } from './command-foreground-tracker'

const PROCESS = { pid: 4001, platform: 'linux' as const, startTime: 'boot:1' }
function row(fields: Partial<AgentHookEventPayload> = {}): AgentHookEventPayload {
  return {
    paneKey: 'pane',
    connectionId: null,
    payload: { state: 'working', prompt: '', agentType: 'codex' },
    agentPresence: { agent: 'codex' },
    ...fields
  }
}
const command = (foreground: CommandForeground, startedAt: number | null = 10) => ({
  foreground,
  startedAt,
  finishedAt: 100
})

describe('commandEndEndsRow', () => {
  it('ends a process-less owner its command ran, or that reported during an unnamed one', () => {
    expect(commandEndEndsRow(row(), 50, command({ kind: 'agent', agent: 'codex' }))).toBe(true)
    expect(commandEndEndsRow(row(), 50, command({ kind: 'unknown' }))).toBe(true)
    expect(commandEndEndsRow(row(), 50, command({ kind: 'unknown' }, null))).toBe(true)
  })

  it('keeps an owner another program or agent held the command for, or idle through it', () => {
    expect(commandEndEndsRow(row(), 50, command({ kind: 'program' }))).toBe(false)
    expect(commandEndEndsRow(row(), 50, command({ kind: 'agent', agent: 'claude' }))).toBe(false)
    expect(commandEndEndsRow(row(), 5, command({ kind: 'unknown' }))).toBe(false)
  })

  it('never decides for an owner with a process, an ended owner, or a newer row', () => {
    const ran = command({ kind: 'agent', agent: 'codex' })
    const owned = row({ agentPresence: { agent: 'codex', process: PROCESS } })
    expect(commandEndEndsRow(owned, 50, ran)).toBe(false)
    expect(
      commandEndEndsRow(row({ agentPresence: { agent: 'codex', ended: true } }), 50, ran)
    ).toBe(false)
    expect(commandEndEndsRow(row({ providerSessionOnly: true }), 50, ran)).toBe(false)
    expect(commandEndEndsRow(row(), 100, ran)).toBe(false)
  })

  it('ends a row with no owner record by the agent it reports', () => {
    const terminal = row({
      agentPresence: undefined,
      payload: { state: 'working', prompt: '', agentType: 'aider' }
    })
    expect(commandEndEndsRow(terminal, 50, command({ kind: 'agent', agent: 'aider' }))).toBe(true)
    expect(commandEndEndsRow(terminal, 50, command({ kind: 'agent', agent: 'codex' }))).toBe(false)
  })

  it('ends a row painted from output under an unrecognized program it reported during', () => {
    // Why: `printf <OSC 9999>; sleep 6` reads as `sleep`; the printing command is the row's agent.
    const terminal = row({ agentPresence: undefined })
    expect(commandEndEndsRow(terminal, 50, command({ kind: 'program' }))).toBe(true)
    expect(commandEndEndsRow(terminal, 5, command({ kind: 'program' }))).toBe(false)
  })
})
