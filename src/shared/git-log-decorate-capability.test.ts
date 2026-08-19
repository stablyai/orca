import { describe, expect, it } from 'vitest'
import {
  GIT_HISTORY_COMMIT_FORMAT,
  GIT_HISTORY_FALLBACK_COMMIT_FORMAT,
  parseGitHistoryLog,
  readGitHistoryDecorations
} from './git-history-log-parser'
import {
  GIT_LOG_DECORATE_PLACEHOLDER,
  hasUnsupportedLogDecorateEcho
} from './git-log-decorate-capability'

const ECHOED_PLACEHOLDER = GIT_LOG_DECORATE_PLACEHOLDER.replace('%x1f', '\x1f')
const DECORATION_FIELD_INDEX = 6

function logRecord(decorations: string, message: string): string {
  return `${['a'.repeat(40), 'Ada', 'ada@example.com', '1700000000', '1700000000', '', decorations, message].join('\n')}\0`
}

describe('git log decorate capability', () => {
  it('places the decorations in the field the probe and parser read', () => {
    expect(GIT_HISTORY_COMMIT_FORMAT.split('%n')[DECORATION_FIELD_INDEX]).toBe(
      GIT_LOG_DECORATE_PLACEHOLDER
    )
    expect(GIT_HISTORY_FALLBACK_COMMIT_FORMAT.split('%n')[DECORATION_FIELD_INDEX]).toBe('%D')
  })

  it('reads the decoration field alone, never the commit message', () => {
    const stdout = logRecord('HEAD -> refs/heads/main', `subject\n\n${ECHOED_PLACEHOLDER}\n`)

    expect(readGitHistoryDecorations(stdout)).toEqual(['HEAD -> refs/heads/main'])
  })

  it('detects the placeholder old git prints instead of decorations', () => {
    expect(
      hasUnsupportedLogDecorateEcho(
        readGitHistoryDecorations(logRecord(ECHOED_PLACEHOLDER, 'feat: x'))
      )
    ).toBe(true)
    expect(hasUnsupportedLogDecorateEcho(['HEAD -> refs/heads/main', ECHOED_PLACEHOLDER])).toBe(
      true
    )
  })

  it('requires the decoration to be the placeholder rather than contain it', () => {
    expect(hasUnsupportedLogDecorateEcho([`refs/heads/main${ECHOED_PLACEHOLDER}`])).toBe(false)
    expect(hasUnsupportedLogDecorateEcho([`${ECHOED_PLACEHOLDER} refs/heads/main`])).toBe(false)
  })

  it('reports support for expanded, empty, and absent decorations', () => {
    expect(hasUnsupportedLogDecorateEcho(['HEAD -> refs/heads/main'])).toBe(false)
    expect(hasUnsupportedLogDecorateEcho([''])).toBe(false)
    // Why: an empty repository yields no records, which must not read as unsupported.
    expect(hasUnsupportedLogDecorateEcho([])).toBe(false)
  })

  it('ignores a commit message that reproduces the echoed placeholder', () => {
    // Why: Git rejects NUL in messages but not the 0x1f the echo carries, so bodies are attacker text.
    const stdout = logRecord('HEAD -> refs/heads/main', `poison\n\n${ECHOED_PLACEHOLDER}\n`)

    expect(hasUnsupportedLogDecorateEcho(readGitHistoryDecorations(stdout))).toBe(false)
    expect(parseGitHistoryLog(stdout)[0]?.message).toContain(ECHOED_PLACEHOLDER)
  })
})
