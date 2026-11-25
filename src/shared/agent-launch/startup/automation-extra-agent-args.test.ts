import { describe, expect, it } from 'vitest'
import { parseExtraAgentArgs } from './automation-extra-agent-args'
import {
  extractAdditionalDirectoriesFromArgs,
  normalizeAdditionalDirectories
} from '../../agent-session/lifecycle/records/agent-session-additional-directories'

describe('automation-extra-agent-args antigravity --add-dir', () => {
  it('accepts repeatable --add-dir flags for antigravity', () => {
    const parsed = parseExtraAgentArgs({
      agent: 'antigravity',
      extraAgentArgs: '--model gemini-2.5-pro --add-dir /repo/a --add-dir=/repo/b'
    })

    expect(parsed).toEqual({
      ok: true,
      tokens: ['--model', 'gemini-2.5-pro', '--add-dir', '/repo/a', '--add-dir=/repo/b'],
      kinds: new Set(['model', 'repeatable'])
    })
  })

  it('extracts and deduplicates --add-dir values while preserving order', () => {
    expect(
      extractAdditionalDirectoriesFromArgs(
        '--model gemini-2.5-pro --add-dir /repo/a --add-dir=/repo/b --add-dir /repo/a'
      )
    ).toEqual(['/repo/a', '/repo/b'])
    expect(normalizeAdditionalDirectories(['  /repo/a ', '/repo/a', ' ', '/repo/b'])).toEqual([
      '/repo/a',
      '/repo/b'
    ])
    expect(normalizeAdditionalDirectories([])).toBeUndefined()
  })
})
