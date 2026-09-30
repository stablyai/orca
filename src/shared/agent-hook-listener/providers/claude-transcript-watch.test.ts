// Unit contract of the Claude transcript watch. Every input here is hand-built; the captured
// stories are in src/main/agent-hooks/server-claude-idle-ctrl-c-captures.test.ts.
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stopClaudeSubagent, upsertWorkingClaudeSubagent } from '../../claude-subagent-roster'
import type { AgentHookEventPayload } from '../listener-event'
import {
  createHookListenerState,
  seedLegacyAgentStatusForTests,
  type HookListenerState
} from '../listener-state'
import {
  catchUpOnClaudeTranscript,
  claudeTranscriptWatchPath,
  observeClaudeTranscript,
  settleClaudeTranscriptWatch,
  syncClaudeTranscriptCursor
} from './claude-transcript-watch'
import { getOrCreateClaudeSubagentRoster, setClaudeMainAgentTurnState } from './claude-roster-state'
import { buildClaudeCachedLeadStatusPayload } from './claude-lifecycle-events'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'
const KILLED = '{"type":"system","subtype":"agents_killed","timestamp":"2026-09-24T19:49:48.826Z"}'
const KILLED_AT = Date.parse('2026-09-24T19:49:48.826Z')
const temporaryPaths: string[] = []

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

function transcriptFile(content = ''): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-claude-transcript-watch-unit-'))
  temporaryPaths.push(dir)
  const path = join(dir, 'session.jsonl')
  writeFileSync(path, content)
  return path
}

function accepted(
  transcriptPath: string | undefined,
  overrides: Partial<AgentHookEventPayload> = {}
): AgentHookEventPayload {
  return {
    paneKey: PANE,
    source: 'claude',
    launchToken: 'launch-1',
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    connectionId: null,
    ...(transcriptPath
      ? { providerSession: { key: 'session_id', id: 'session-1', transcriptPath } }
      : {}),
    payload: { state: 'working', prompt: 'go', agentType: 'claude' },
    ...overrides
  }
}

function paneWithWorkingChild(startedAt = KILLED_AT - 5_000): HookListenerState {
  const state = createHookListenerState()
  setClaudeMainAgentTurnState(state, PANE, { state: 'done', turnCompletedAt: KILLED_AT - 6_000 })
  upsertWorkingClaudeSubagent(getOrCreateClaudeSubagentRoster(state, PANE), 'a1', {}, startedAt)
  return state
}

/** Stores the row the listener's records make now, as a host would have published it. */
function publishRecords(state: HookListenerState, transcript: string): AgentHookEventPayload {
  const payload = buildClaudeCachedLeadStatusPayload(state, 'Stop', PANE, {})
  if (!payload) {
    throw new Error('no main agent record')
  }
  const row = accepted(transcript, {
    hookEventName: 'Stop',
    claudeRunningNonAgentTask: false,
    payload
  })
  seedLegacyAgentStatusForTests(state, row)
  return row
}

describe('claudeTranscriptWatchPath', () => {
  it('watches an absolute path on a POSIX host', () => {
    expect(claudeTranscriptWatchPath('/home/u/.claude/projects/p/s.jsonl', 'linux')).toBe(
      '/home/u/.claude/projects/p/s.jsonl'
    )
    expect(claudeTranscriptWatchPath('projects/s.jsonl', 'darwin')).toBeUndefined()
  })

  it('watches only a local drive path on Windows', () => {
    expect(claudeTranscriptWatchPath('C:\\Users\\u\\.claude\\s.jsonl', 'win32')).toBe(
      'C:\\Users\\u\\.claude\\s.jsonl'
    )
    // A WSL guest path, its UNC form, and a share are the guest relay's or unwatchable.
    expect(claudeTranscriptWatchPath('/home/u/.claude/s.jsonl', 'win32')).toBeUndefined()
    expect(
      claudeTranscriptWatchPath('\\\\wsl.localhost\\Ubuntu\\home\\u\\s.jsonl', 'win32')
    ).toBeUndefined()
    expect(claudeTranscriptWatchPath('\\\\server\\share\\s.jsonl', 'win32')).toBeUndefined()
    expect(claudeTranscriptWatchPath('C:s.jsonl', 'win32')).toBeUndefined()
  })
})

describe('syncClaudeTranscriptCursor', () => {
  it('arms at the end of the transcript while a reason holds', () => {
    const transcript = transcriptFile(`${KILLED}\n`)
    const state = paneWithWorkingChild()
    expect(syncClaudeTranscriptCursor(state, accepted(transcript))).toBe(true)
    expect(state.claudeTranscriptCursorByPaneKey.get(PANE)).toMatchObject({
      filePath: transcript,
      offset: KILLED.length + 1,
      carry: '',
      reasons: new Set(['agent-child-working'])
    })
    // A row that reports no transcript keeps the armed one.
    expect(syncClaudeTranscriptCursor(state, accepted(undefined))).toBe(true)
  })

  it('does not arm without a reason, or for a relayed row', () => {
    const state = createHookListenerState()
    setClaudeMainAgentTurnState(state, PANE, { state: 'done' })
    expect(syncClaudeTranscriptCursor(state, accepted(transcriptFile()))).toBe(false)
    const watched = paneWithWorkingChild()
    expect(
      syncClaudeTranscriptCursor(watched, accepted(transcriptFile(), { connectionId: 'conn-1' }))
    ).toBe(false)
    expect(watched.claudeTranscriptCursorByPaneKey.has(PANE)).toBe(false)
  })

  it('drops the cursor when the accepted row names a path this host cannot read', () => {
    const transcript = transcriptFile()
    const state = paneWithWorkingChild()
    syncClaudeTranscriptCursor(state, accepted(transcript))
    expect(syncClaudeTranscriptCursor(state, accepted(join(transcript, 'missing')))).toBe(false)
    expect(state.claudeTranscriptCursorByPaneKey.has(PANE)).toBe(false)
  })

  it('never resets the cursor when the reasons change', () => {
    const transcript = transcriptFile()
    const state = paneWithWorkingChild()
    syncClaudeTranscriptCursor(state, accepted(transcript))
    appendFileSync(transcript, '{"type":"user"}\n')
    // The last reason ends at an event; the cursor stays where it was until a read.
    stopClaudeSubagent(getOrCreateClaudeSubagentRoster(state, PANE), 'a1')
    expect(syncClaudeTranscriptCursor(state, accepted(transcript))).toBe(true)
    expect(state.claudeTranscriptCursorByPaneKey.get(PANE)).toMatchObject({
      offset: 0,
      reasons: new Set(['agent-child-working'])
    })
  })

  it('repoints to the new session file on a session change and keeps the reasons it watched', () => {
    // `/clear`: SessionStart(clear) names a new session and a new transcript, while work the
    // reasons track can outlive the old session.
    const before = transcriptFile()
    const state = paneWithWorkingChild()
    syncClaudeTranscriptCursor(state, accepted(before))
    const after = transcriptFile('{"type":"user","copied":true}\n')
    expect(
      syncClaudeTranscriptCursor(
        state,
        accepted(after, {
          hookEventName: 'SessionStart',
          providerSession: { key: 'session_id', id: 'session-2', transcriptPath: after }
        })
      )
    ).toBe(true)
    expect(state.claudeTranscriptCursorByPaneKey.get(PANE)).toMatchObject({
      filePath: after,
      offset: statSync(after).size,
      reasons: new Set(['agent-child-working'])
    })
    appendFileSync(after, `${KILLED}\n`)
    catchUpOnClaudeTranscript(state, PANE)
    expect(state.claudeSubagentRosterByPaneKey.has(PANE)).toBe(false)
  })

  it('repoints on a session change even when the records end every reason there, and disarms only after the next read', () => {
    const before = transcriptFile()
    const state = paneWithWorkingChild()
    syncClaudeTranscriptCursor(state, accepted(before))
    state.claudeSubagentRosterByPaneKey.delete(PANE)
    const after = transcriptFile()
    expect(syncClaudeTranscriptCursor(state, accepted(after))).toBe(true)
    expect(state.claudeTranscriptCursorByPaneKey.get(PANE)?.filePath).toBe(after)
    seedLegacyAgentStatusForTests(
      state,
      accepted(after, { payload: { state: 'done', prompt: '', agentType: 'claude' } })
    )
    expect(observeClaudeTranscript(state, PANE)).toMatchObject({ kind: 'read', factApplied: false })
    expect(settleClaudeTranscriptWatch(state, PANE, false)).toBe(false)
    expect(state.claudeTranscriptCursorByPaneKey.has(PANE)).toBe(false)
  })
})

describe('catchUpOnClaudeTranscript', () => {
  it('applies a fact from the existing cursor and never creates one', () => {
    const transcript = transcriptFile()
    const state = paneWithWorkingChild()
    appendFileSync(transcript, `${KILLED}\n`)
    catchUpOnClaudeTranscript(state, PANE)
    expect(state.claudeTranscriptCursorByPaneKey.has(PANE)).toBe(false)
    expect(state.claudeSubagentRosterByPaneKey.get(PANE)?.get('a1')?.state).toBe('working')

    syncClaudeTranscriptCursor(state, accepted(transcript))
    appendFileSync(transcript, `${KILLED}\n`)
    catchUpOnClaudeTranscript(state, PANE)
    expect(state.claudeSubagentRosterByPaneKey.has(PANE)).toBe(false)
    expect(state.claudeTranscriptCursorByPaneKey.get(PANE)?.unpublished).toEqual({
      hookEventName: 'SubagentStop',
      toolAgentId: 'a1'
    })
  })

  it('still reads for a reason that ended after the row was written, before the read', () => {
    const transcript = transcriptFile()
    const state = paneWithWorkingChild()
    syncClaudeTranscriptCursor(state, accepted(transcript))
    appendFileSync(transcript, `${KILLED}\n`)
    stopClaudeSubagent(getOrCreateClaudeSubagentRoster(state, PANE), 'a1')
    const parse = vi.spyOn(JSON, 'parse')
    catchUpOnClaudeTranscript(state, PANE)
    expect(parse).toHaveBeenCalledWith(KILLED)
    expect(state.claudeTranscriptCursorByPaneKey.get(PANE)?.reasons.size).toBe(0)
  })

  it('never parses a line no watched reason admits', () => {
    const transcript = transcriptFile()
    const state = paneWithWorkingChild()
    syncClaudeTranscriptCursor(state, accepted(transcript))
    // The size of the per-turn snapshot attachment Claude writes, with none of the markers.
    const snapshot = JSON.stringify({ type: 'attachment', text: 'x'.repeat(56 * 1024) })
    appendFileSync(transcript, `${snapshot}\n`)
    const parse = vi.spyOn(JSON, 'parse')
    catchUpOnClaudeTranscript(state, PANE)
    expect(parse).not.toHaveBeenCalled()
    expect(state.claudeTranscriptCursorByPaneKey.get(PANE)?.offset).toBe(statSync(transcript).size)
  })
})

describe('observeClaudeTranscript', () => {
  it("publishes the retirement as the waiting child's own stop and restores its wait", () => {
    const transcript = transcriptFile()
    const state = paneWithWorkingChild()
    upsertWorkingClaudeSubagent(
      getOrCreateClaudeSubagentRoster(state, PANE),
      'a2',
      {},
      KILLED_AT - 1_000
    )
    const settled = state.claudeLeadStateByPaneKey.get(PANE)
    setClaudeMainAgentTurnState(state, PANE, {
      state: 'waiting',
      waitingAgentId: 'a2',
      stateBeforeWait: settled
    })
    publishRecords(state, transcript)
    syncClaudeTranscriptCursor(state, accepted(transcript))
    appendFileSync(transcript, `${KILLED}\n`)

    const observed = observeClaudeTranscript(state, PANE)
    expect(observed).toMatchObject({
      kind: 'read',
      factApplied: true,
      row: {
        hookEventName: 'SubagentStop',
        toolAgentId: 'a2',
        launchToken: 'launch-1',
        connectionId: null,
        claudeRunningNonAgentTask: false,
        payload: { state: 'done', mainAgent: { state: 'done' } }
      }
    })
    // A fact is the hook Claude did not send, not a restatement.
    expect(observed).not.toHaveProperty('row.restatesRecords')
    expect(state.claudeSubagentRosterByPaneKey.has(PANE)).toBe(false)
    expect(state.claudeLeadStateByPaneKey.get(PANE)).toMatchObject({ state: 'done' })
    if (observed.kind === 'read' && observed.row) {
      seedLegacyAgentStatusForTests(state, observed.row)
    }
    // A read that applied a fact keeps the watch for one more read.
    expect(settleClaudeTranscriptWatch(state, PANE, true)).toBe(true)
    expect(observeClaudeTranscript(state, PANE)).toEqual({ kind: 'read', factApplied: false })
    expect(settleClaudeTranscriptWatch(state, PANE, false)).toBe(false)
  })

  it('counts a line with an unreadable timestamp against every child tracked by then', () => {
    const transcript = transcriptFile()
    const state = paneWithWorkingChild(Date.now())
    publishRecords(state, transcript)
    syncClaudeTranscriptCursor(state, accepted(transcript))
    appendFileSync(transcript, '{"type":"system","subtype":"agents_killed"}\n')
    expect(observeClaudeTranscript(state, PANE)).toMatchObject({ row: { toolAgentId: 'a1' } })
  })

  it('retires the children but wakes no main agent it never saw', () => {
    const transcript = transcriptFile()
    const state = paneWithWorkingChild()
    publishRecords(state, transcript)
    state.claudeLeadStateByPaneKey.delete(PANE)
    syncClaudeTranscriptCursor(state, accepted(transcript))
    appendFileSync(transcript, `${KILLED}\n`)
    expect(observeClaudeTranscript(state, PANE)).toEqual({ kind: 'read', factApplied: true })
    expect(state.claudeSubagentRosterByPaneKey.has(PANE)).toBe(false)
  })

  it('restates the records when the stored row does not show them, as an observation', () => {
    const transcript = transcriptFile()
    const state = paneWithWorkingChild()
    publishRecords(state, transcript)
    syncClaudeTranscriptCursor(state, accepted(transcript))
    expect(observeClaudeTranscript(state, PANE)).toEqual({ kind: 'read', factApplied: false })
    // A change of the records no row carried (an event that produced no row).
    stopClaudeSubagent(getOrCreateClaudeSubagentRoster(state, PANE), 'a1')
    const observed = observeClaudeTranscript(state, PANE)
    expect(observed).toMatchObject({
      kind: 'read',
      row: { restatesRecords: true, payload: { state: 'done' } }
    })
    expect(observed.kind === 'read' && observed.row?.hookEventName).toBeUndefined()
  })

  it('keeps the hook that raised a wait on a restated waiting row', () => {
    const transcript = transcriptFile()
    const state = paneWithWorkingChild()
    setClaudeMainAgentTurnState(state, PANE, { state: 'waiting' })
    const payload = buildClaudeCachedLeadStatusPayload(state, 'PermissionRequest', PANE, {})
    if (!payload) {
      throw new Error('no row')
    }
    seedLegacyAgentStatusForTests(
      state,
      accepted(transcript, {
        hookEventName: 'PermissionRequest',
        toolUseId: 'toolu_1',
        claudeRunningNonAgentTask: false,
        payload: { ...payload, subagents: undefined }
      })
    )
    syncClaudeTranscriptCursor(state, accepted(transcript))
    expect(observeClaudeTranscript(state, PANE)).toMatchObject({
      row: {
        hookEventName: 'PermissionRequest',
        toolUseId: 'toolu_1',
        payload: { state: 'waiting' }
      }
    })
  })

  it("keeps a main agent's waiting hook when the fact retired another child", () => {
    const transcript = transcriptFile()
    const state = paneWithWorkingChild()
    setClaudeMainAgentTurnState(state, PANE, { state: 'waiting' })
    const payload = buildClaudeCachedLeadStatusPayload(state, 'PermissionRequest', PANE, {})
    if (!payload) {
      throw new Error('no row')
    }
    seedLegacyAgentStatusForTests(
      state,
      accepted(transcript, {
        hookEventName: 'PermissionRequest',
        toolUseId: 'toolu_1',
        claudeRunningNonAgentTask: false,
        payload
      })
    )
    syncClaudeTranscriptCursor(state, accepted(transcript))
    appendFileSync(transcript, `${KILLED}\n`)
    const observed = observeClaudeTranscript(state, PANE)
    expect(observed).toMatchObject({
      factApplied: true,
      row: {
        hookEventName: 'PermissionRequest',
        toolUseId: 'toolu_1',
        toolAgentId: undefined,
        payload: { state: 'waiting' }
      }
    })
    expect(observed.kind === 'read' && observed.row?.payload.subagents).toBeUndefined()
  })

  it('never restates a dismissed row, but a fact still does what its missing hook would', () => {
    const transcript = transcriptFile()
    const state = paneWithWorkingChild()
    const row = publishRecords(state, transcript)
    seedLegacyAgentStatusForTests(state, { ...row, providerSessionOnly: true })
    syncClaudeTranscriptCursor(state, accepted(transcript))
    state.claudeSubagentRosterByPaneKey.get(PANE)?.set('a0', {
      state: 'working',
      startedAt: KILLED_AT + 60_000
    })
    expect(observeClaudeTranscript(state, PANE)).toEqual({ kind: 'read', factApplied: false })
    appendFileSync(transcript, `${KILLED}\n`)
    expect(observeClaudeTranscript(state, PANE)).toMatchObject({
      row: { hookEventName: 'SubagentStop', toolAgentId: 'a1' }
    })
  })

  it('stops for a pane with no row, and drops the cursor of a row another host or agent owns', () => {
    const transcript = transcriptFile()
    const state = paneWithWorkingChild()
    syncClaudeTranscriptCursor(state, accepted(transcript))
    expect(observeClaudeTranscript(state, PANE)).toEqual({ kind: 'stop' })
    expect(state.claudeTranscriptCursorByPaneKey.has(PANE)).toBe(true)
    seedLegacyAgentStatusForTests(
      state,
      accepted(transcript, { payload: { state: 'working', prompt: '', agentType: 'codex' } })
    )
    expect(observeClaudeTranscript(state, PANE)).toEqual({ kind: 'stop' })
    expect(state.claudeTranscriptCursorByPaneKey.has(PANE)).toBe(false)
  })
})
