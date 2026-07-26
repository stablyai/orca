import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import {
  formatHermesSessionMessagesWithinLimits,
  HERMES_RUN_PAGE_OUTPUT_OMITTED_ERROR,
  HERMES_SESSION_RUN_METADATA_MAX_BYTES,
  HERMES_SESSION_RUN_SELECT_SQL,
  HERMES_SESSION_TRANSCRIPT_TRUNCATED_ERROR,
  hydrateHermesRunPageWithinLimits
} from './hermes-run-output-limits'

describe('HERMES_SESSION_RUN_SELECT_SQL', () => {
  it('preserves exact-limit text metadata and rejects oversized non-numeric fields in SQL', () => {
    const database = new DatabaseSync(':memory:')
    database.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      started_at,
      ended_at,
      model TEXT,
      message_count,
      input_tokens,
      output_tokens
    )`)
    const exactTitle = 't'.repeat(HERMES_SESSION_RUN_METADATA_MAX_BYTES)
    const exactModel = 'm'.repeat(HERMES_SESSION_RUN_METADATA_MAX_BYTES)
    database
      .prepare(
        `INSERT INTO sessions (
          id, title, started_at, ended_at, model, message_count, input_tokens, output_tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('run-1', exactTitle, 1, 2, exactModel, 3, 4, 5)

    const exact = database.prepare(HERMES_SESSION_RUN_SELECT_SQL).get('run-1')
    expect(exact).toEqual({
      title: exactTitle,
      started_at: 1,
      ended_at: 2,
      model: exactModel,
      message_count: 3,
      input_tokens: 4,
      output_tokens: 5
    })

    database.exec(`UPDATE sessions SET
      title = title || 'overflow',
      model = model || 'overflow',
      started_at = zeroblob(1048576),
      ended_at = zeroblob(1048576),
      message_count = zeroblob(1048576),
      input_tokens = zeroblob(1048576),
      output_tokens = zeroblob(1048576)
    WHERE id = 'run-1'`)
    const bounded = database.prepare(HERMES_SESSION_RUN_SELECT_SQL).get('run-1')

    expect(Buffer.byteLength(String(bounded?.title))).toBe(HERMES_SESSION_RUN_METADATA_MAX_BYTES)
    expect(Buffer.byteLength(String(bounded?.model))).toBe(HERMES_SESSION_RUN_METADATA_MAX_BYTES)
    expect(bounded).toMatchObject({
      started_at: null,
      ended_at: null,
      message_count: null,
      input_tokens: null,
      output_tokens: null
    })
    database.close()
  })
})

describe('formatHermesSessionMessagesWithinLimits', () => {
  it('preserves transcript formatting below the limits', () => {
    const result = formatHermesSessionMessagesWithinLimits([
      {
        role: 'assistant',
        tool_name: ' terminal ',
        reasoning_content: ' because ',
        content: ' done '
      },
      { role: null, content: '   ' }
    ])

    expect(result).toEqual({
      content: [
        '## assistant / terminal',
        '',
        '### Reasoning',
        '',
        'because',
        '',
        'done',
        '',
        '---',
        '',
        '## message',
        '',
        '(empty)'
      ].join('\n'),
      truncated: false
    })
  })

  it('keeps UTF-8 output within the byte budget and explains truncation', () => {
    const result = formatHermesSessionMessagesWithinLimits(
      [{ role: 'assistant', content: '🐋'.repeat(100) }],
      { maxBytes: 160 }
    )

    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.content ?? '')).toBeLessThanOrEqual(160)
    expect(result.content).toContain(HERMES_SESSION_TRANSCRIPT_TRUNCATED_ERROR)
    expect(result.content).not.toContain('\ufffd')
  })

  it('stops pulling rows after the message limit', () => {
    let rowsPulled = 0
    function* messages(): Generator<Record<string, unknown>> {
      for (let index = 0; index < 100; index += 1) {
        rowsPulled += 1
        yield { role: 'user', content: `message ${index}` }
      }
    }

    const result = formatHermesSessionMessagesWithinLimits(messages(), {
      maxBytes: 1024,
      maxMessages: 2
    })

    expect(rowsPulled).toBe(3)
    expect(result.truncated).toBe(true)
    expect(result.content).toContain('message 0')
    expect(result.content).toContain('message 1')
    expect(result.content).not.toContain('message 2')
  })
})

describe('hydrateHermesRunPageWithinLimits', () => {
  it('bounds concurrency, preserves order, and omits aggregate overflow', async () => {
    let active = 0
    let maxActive = 0
    const refs = ['first', 'second', 'third', 'fourth']

    const runs = (await hydrateHermesRunPageWithinLimits(
      refs,
      async (id) => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise<void>((resolve) => setTimeout(resolve, 1))
        active -= 1
        return { id, output_content: id.slice(0, 3) }
      },
      { maxConcurrent: 2, maxRetainedBytes: 5 }
    )) as { id: string; output_content: string | null; error?: string }[]

    expect(maxActive).toBe(2)
    expect(runs.map((run) => run.id)).toEqual(refs)
    expect(runs[0]?.output_content).toBe('fir')
    expect(runs.slice(1)).toEqual(
      refs.slice(1).map((id) => ({
        id,
        output_content: null,
        error: HERMES_RUN_PAGE_OUTPUT_OMITTED_ERROR
      }))
    )
  })
})
