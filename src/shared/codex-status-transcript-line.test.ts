import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  createCodexSubagentTranscriptState,
  reconcileCodexSubagentTranscript
} from './codex-subagent-transcript'
import type { CodexSubagentRoster } from './codex-subagent-roster'
import { createHookListenerState } from './agent-hook-listener/listener-state'
import { buildCodexChildDrivenStatusPayload } from './agent-hook-listener/providers/codex-events'
import { pollCodexTranscriptStatus } from './agent-hook-listener/providers/codex-transcript-poll'
import { transcriptPollUpdate } from './agent-hook-listener/transcript-poll-policy'
import { reconcileCodexSubagentReviewer } from './codex-subagent-reviewer'
import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'

it('skips decoding 1,000 message/token records and unchanged reads, but retains an abort', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-status-budget-'))
  const path = join(directory, 'rollout.jsonl')
  const state = createCodexSubagentTranscriptState()
  const roster: CodexSubagentRoster = new Map()
  writeFileSync(path, '')
  reconcileCodexSubagentTranscript(state, roster, path)
  const irrelevantRecords = Array.from({ length: 1_000 }, (_, i) =>
    JSON.stringify({
      type: 'event_msg',
      payload: { type: i % 2 ? 'agent_message' : 'token_count', message: 'message' }
    })
  ).join('\n')
  appendFileSync(path, `${irrelevantRecords}\n`)
  const parse = vi.spyOn(JSON, 'parse')
  try {
    expect(reconcileCodexSubagentTranscript(state, roster, path)).toBe(false)
    expect(parse).not.toHaveBeenCalled()
    appendFileSync(
      path,
      '{"type":"event_msg","payload":{"type":"turn_aborted","reason":"interrupted"}}\n'
    )
    expect(reconcileCodexSubagentTranscript(state, roster, path)).toBe(true)
    expect(parse).toHaveBeenCalledOnce()
    expect(state.rootTurn.interrupted).toBe(true)
    expect(reconcileCodexSubagentTranscript(state, roster, path)).toBe(false)
    expect(parse).toHaveBeenCalledOnce()
    appendFileSync(
      path,
      '{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":82}}}}\n'
    )
    expect(reconcileCodexSubagentTranscript(state, roster, path)).toBe(false)
    expect(parse).toHaveBeenCalledTimes(2)
  } finally {
    parse.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  }
})

it.each([10, 100])(
  'does no roster rebuild or comparison for child quota at %i children',
  (count) => {
    const directory = mkdtempSync(join(tmpdir(), 'codex-child-quota-budget-'))
    const path = join(directory, 'parent.jsonl')
    const childPath = join(directory, 'child-0.jsonl')
    const state = createHookListenerState()
    const transcript = createCodexSubagentTranscriptState()
    const roster: CodexSubagentRoster = new Map()
    const paneKey = 'pane'
    writeFileSync(path, '')
    reconcileCodexSubagentTranscript(transcript, roster, path)
    for (let index = 0; index < count; index++) {
      const filePath = join(directory, `child-${index}.jsonl`)
      writeFileSync(filePath, '')
      roster.set(`child-${index}`, { state: 'working', startedAt: index + 1 })
      transcript.subagents.set(`child-${index}`, {
        filePath,
        offset: 0,
        carry: '',
        startedAt: index + 1
      })
    }
    state.codexSubagentTranscriptByPaneKey.set(paneKey, transcript)
    state.codexSubagentRosterByPaneKey.set(paneKey, roster)
    state.codexLeadStateByPaneKey.set(paneKey, {
      state: 'working',
      stateStartedAt: 1,
      turnId: 'root'
    })
    const original: AgentHookEventPayload = {
      paneKey,
      source: 'codex',
      connectionId: null,
      payload: buildCodexChildDrivenStatusPayload(state, undefined, paneKey, {})
    }
    reconcileCodexSubagentReviewer(transcript, childPath)
    appendFileSync(
      childPath,
      '{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":42}}}}\n'
    )
    const parse = vi.spyOn(JSON, 'parse')
    const stringify = vi.spyOn(JSON, 'stringify')
    try {
      const polled = pollCodexTranscriptStatus(state, original, {}, 'production')
      expect(polled).toBe(original)
      expect(transcriptPollUpdate('codex', original, polled)).toBeUndefined()
      reconcileCodexSubagentReviewer(transcript, childPath)
      expect(parse).not.toHaveBeenCalled()
      expect(stringify).not.toHaveBeenCalled()

      appendFileSync(
        childPath,
        '{"type":"turn_context","payload":{"model":"gpt-6.1-sol","approvals_reviewer":"auto_review"}}\n'
      )
      const changed = pollCodexTranscriptStatus(state, original, {}, 'production')
      expect(transcriptPollUpdate('codex', original, changed)).toBeDefined()
      expect(roster.get('child-0')?.model).toBe('gpt-6.1-sol')
      reconcileCodexSubagentReviewer(transcript, childPath)
      expect(transcript.reviewersByPath.get(childPath)).toBe('auto_review')
    } finally {
      parse.mockRestore()
      stringify.mockRestore()
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
