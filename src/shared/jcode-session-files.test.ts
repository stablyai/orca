import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>()
}))

vi.mock('os', async () => {
  const actual = (await vi.importActual('os')) as Record<string, unknown>
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

  it('rejects unsafe session ids before touching the filesystem', () => {
    expect(readLastJcodeUserPromptFromHookPayload({ session_id: '../../etc/passwd' })).toBeNull()
    expect(readLastJcodeUserPromptFromHookPayload({})).toBeNull()
  })
})
