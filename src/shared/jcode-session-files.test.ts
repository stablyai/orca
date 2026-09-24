import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>()
}))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return { ...actual, homedir: homedirMock }
})

import { readLastJcodeUserPromptFromHookPayload } from './jcode-session-files'

describe('shared jcode-session-files', () => {
  let homeDir: string
  let sessionsDir: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'orca-jcode-sessions-'))
    homedirMock.mockReturnValue(homeDir)
    sessionsDir = join(homeDir, '.jcode', 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('returns the last real user prompt from the live journal', () => {
    writeFileSync(
      join(sessionsDir, 'session_a_1.journal.jsonl'),
      [
        JSON.stringify({
          meta: { id: 'session_a_1' },
          append_messages: [
            {
              id: 'm1',
              role: 'user',
              display_role: 'system',
              content: [{ type: 'text', text: '<system-reminder>injected</system-reminder>' }]
            },
            { id: 'm2', role: 'user', content: [{ type: 'text', text: 'fix the flaky test' }] }
          ]
        })
      ].join('\n')
    )
    const found = readLastJcodeUserPromptFromHookPayload({ session_id: 'session_a_1' })
    expect(found?.text).toBe('fix the flaky test')
    expect(found?.interactionKey).toContain('jcode-transcript')
  })

  it('falls back to the consolidated session doc when the journal is missing', () => {
    writeFileSync(
      join(sessionsDir, 'session_b_2.json'),
      JSON.stringify({
        id: 'session_b_2',
        messages: [
          { id: 'm1', role: 'user', display_role: 'system', content: 'injected context' },
          { id: 'm2', role: 'user', content: [{ type: 'text', text: 'hello jcode' }] },
          { id: 'm3', role: 'assistant', content: 'hi' }
        ]
      })
    )
    const found = readLastJcodeUserPromptFromHookPayload({ session_id: 'session_b_2' })
    expect(found?.text).toBe('hello jcode')
  })

  it('skips injected context and returns null when only system content exists', () => {
    writeFileSync(
      join(sessionsDir, 'session_c_3.journal.jsonl'),
      JSON.stringify({
        meta: { id: 'session_c_3' },
        append_messages: [
          {
            id: 'm1',
            role: 'user',
            display_role: 'system',
            content: [{ type: 'text', text: '<system-reminder>context</system-reminder>' }]
          }
        ]
      })
    )
    expect(readLastJcodeUserPromptFromHookPayload({ session_id: 'session_c_3' })).toBeNull()
  })

  it('keys a prompt by its place in the file, so appends do not remint the key', () => {
    // Why: the backward scan windows the file from EOF, so appending shifts every window
    // boundary and a region-local line index reminted the key for a prompt that never
    // moved. A repeated turn_end would then slip past the same-hash dedupe as a second
    // done event with duplicate agent_prompt_sent telemetry.
    const journalPath = join(sessionsDir, 'session_d_4.journal.jsonl')
    const filler = (index: number) =>
      JSON.stringify({
        meta: { id: 'session_d_4' },
        append_messages: [],
        index,
        pad: 'x'.repeat(400)
      })
    const prompt = JSON.stringify({
      meta: { id: 'session_d_4' },
      append_messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'keep me' }] }]
    })
    // 200 lines before and 100 after put the prompt in the second 64 KiB window, far
    // enough from that window's start that a shifted boundary changes its line index.
    const before = Array.from({ length: 200 }, (_, index) => filler(index))
    const after = Array.from({ length: 100 }, (_, index) => filler(1000 + index))

    writeFileSync(journalPath, [...before, prompt, ...after].join('\n'))
    const firstRead = readLastJcodeUserPromptFromHookPayload({ session_id: 'session_d_4' })

    writeFileSync(journalPath, [...before, prompt, ...after, filler(9999)].join('\n'))
    const afterAppend = readLastJcodeUserPromptFromHookPayload({ session_id: 'session_d_4' })

    expect(firstRead?.text).toBe('keep me')
    expect(afterAppend?.text).toBe('keep me')
    expect(afterAppend?.interactionKey).toBe(firstRead?.interactionKey)
  })

  it('rejects unsafe session ids before touching the filesystem', () => {
    expect(readLastJcodeUserPromptFromHookPayload({ session_id: '../../etc/passwd' })).toBeNull()
    expect(readLastJcodeUserPromptFromHookPayload({})).toBeNull()
  })
})
