import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { upsertWorkingClaudeSubagent } from '../../claude-subagent-roster'
import type { AgentHookEventPayload } from '../listener-event'
import { createHookListenerState, type HookListenerState } from '../listener-state'
import {
  claudeTranscriptWatchPath,
  pollClaudeAgentsKilled,
  syncClaudeAgentsKilledWatch
} from './claude-agents-killed-transcript'
import { getOrCreateClaudeSubagentRoster, setClaudeMainAgentTurnState } from './claude-roster-state'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'
const KILLED = '{"type":"system","subtype":"agents_killed","timestamp":"2026-09-24T19:49:48.826Z"}'
const KILLED_AT = Date.parse('2026-09-24T19:49:48.826Z')
const temporaryPaths: string[] = []

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

function transcriptFile(content = ''): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-agents-killed-unit-'))
  temporaryPaths.push(dir)
  const path = join(dir, 'session.jsonl')
  writeFileSync(path, content)
  return path
}

function anchor(transcriptPath: string | undefined, connectionId: string | null = null) {
  const event: AgentHookEventPayload = {
    paneKey: PANE,
    source: 'claude',
    launchToken: 'launch-1',
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    connectionId,
    ...(transcriptPath
      ? { providerSession: { key: 'session_id', id: 'session-1', transcriptPath } }
      : {}),
    payload: { state: 'working', prompt: 'go', agentType: 'claude' }
  }
  return event
}

function paneWithWorkingChild(startedAt = KILLED_AT - 5_000): HookListenerState {
  const state = createHookListenerState()
  setClaudeMainAgentTurnState(state, PANE, { state: 'done', turnCompletedAt: KILLED_AT - 6_000 })
  upsertWorkingClaudeSubagent(getOrCreateClaudeSubagentRoster(state, PANE), 'a1', {}, startedAt)
  return state
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

describe('syncClaudeAgentsKilledWatch', () => {
  it('arms at the end of the transcript while an agent child works', () => {
    const transcript = transcriptFile(`${KILLED}\n`)
    const state = paneWithWorkingChild()
    expect(syncClaudeAgentsKilledWatch(state, anchor(transcript))).toBe(true)
    expect(state.claudeAgentsKilledCursorByPaneKey.get(PANE)).toEqual({
      filePath: transcript,
      offset: KILLED.length + 1,
      carry: ''
    })
    // A row that reports no transcript keeps the armed one.
    expect(syncClaudeAgentsKilledWatch(state, anchor(undefined))).toBe(true)
  })

  it("never watches a relayed row: the session's own host does", () => {
    const state = paneWithWorkingChild()
    expect(syncClaudeAgentsKilledWatch(state, anchor(transcriptFile(), 'conn-1'))).toBe(false)
    expect(state.claudeAgentsKilledCursorByPaneKey.has(PANE)).toBe(false)
  })

  it('disarms without a working agent child or a readable transcript', () => {
    const transcript = transcriptFile()
    const state = paneWithWorkingChild()
    expect(syncClaudeAgentsKilledWatch(state, anchor(transcript))).toBe(true)
    expect(syncClaudeAgentsKilledWatch(state, anchor(join(transcript, 'missing')))).toBe(false)
    expect(state.claudeAgentsKilledCursorByPaneKey.has(PANE)).toBe(false)
    state.claudeSubagentRosterByPaneKey.delete(PANE)
    expect(syncClaudeAgentsKilledWatch(state, anchor(transcript))).toBe(false)
  })
})

describe('pollClaudeAgentsKilled', () => {
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
    expect(syncClaudeAgentsKilledWatch(state, anchor(transcript))).toBe(true)
    appendFileSync(transcript, `${KILLED}\n`)

    expect(pollClaudeAgentsKilled(state, anchor(transcript))).toMatchObject({
      hookEventName: 'SubagentStop',
      toolAgentId: 'a2',
      launchToken: 'launch-1',
      connectionId: null,
      claudeRunningNonAgentTask: false,
      payload: { state: 'done', mainAgent: { state: 'done' } }
    })
    expect(state.claudeSubagentRosterByPaneKey.has(PANE)).toBe(false)
    expect(state.claudeLeadStateByPaneKey.get(PANE)).toMatchObject({ state: 'done' })
  })

  it('counts a line with an unreadable timestamp against every child tracked by then', () => {
    const transcript = transcriptFile()
    const state = paneWithWorkingChild(Date.now())
    syncClaudeAgentsKilledWatch(state, anchor(transcript))
    appendFileSync(transcript, '{"type":"system","subtype":"agents_killed"}\n')
    expect(pollClaudeAgentsKilled(state, anchor(transcript))).toMatchObject({ toolAgentId: 'a1' })
  })

  it('retires the children but wakes no main agent it never saw', () => {
    const transcript = transcriptFile()
    const state = paneWithWorkingChild()
    state.claudeLeadStateByPaneKey.delete(PANE)
    syncClaudeAgentsKilledWatch(state, anchor(transcript))
    appendFileSync(transcript, `${KILLED}\n`)
    expect(pollClaudeAgentsKilled(state, anchor(transcript))).toBeUndefined()
    expect(state.claudeSubagentRosterByPaneKey.has(PANE)).toBe(false)
  })
})
