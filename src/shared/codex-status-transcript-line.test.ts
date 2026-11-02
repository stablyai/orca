import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  createCodexSubagentTranscriptState,
  reconcileCodexSubagentTranscript
} from './codex-subagent-transcript'
import type { CodexSubagentRoster } from './codex-subagent-roster'

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
  } finally {
    parse.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  }
})
