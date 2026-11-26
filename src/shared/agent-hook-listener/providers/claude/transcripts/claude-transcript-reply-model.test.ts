import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { readClaudeTranscriptReplyModelAsync } from './claude-transcript-reply-model'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'claude-reply-model-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function transcript(records: Record<string, unknown>[]): string {
  const path = join(root, 'session.jsonl')
  writeFileSync(path, records.map((record) => `${JSON.stringify(record)}\n`).join(''))
  return path
}
const assistant = (model: string, extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  message: { role: 'assistant', model, content: [{ type: 'text', text: 'ok' }] },
  ...extra
})
const user = (content: unknown) => ({ type: 'user', message: { role: 'user', content } })

it('reads the model of the reply after the latest prompt, past tool results and repair text', async () => {
  const path = transcript([
    user('go'),
    assistant('claude-fable-5-2'),
    user([{ type: 'tool_result', tool_use_id: 't1', content: 'done' }]),
    assistant('claude-haiku-5-5', { isSidechain: true }),
    assistant('<synthetic>'),
    { type: 'system', subtype: 'turn_duration' }
  ])
  expect(await readClaudeTranscriptReplyModelAsync(path, () => true)).toBe('claude-fable-5-2')
})

it('reports no reply yet when a prompt or /model output follows the last reply', async () => {
  const path = transcript([
    assistant('claude-opus-5-5'),
    user('<local-command-stdout>Set model to Fable 5.2</local-command-stdout>')
  ])
  expect(await readClaudeTranscriptReplyModelAsync(path, () => true)).toBeNull()
})
