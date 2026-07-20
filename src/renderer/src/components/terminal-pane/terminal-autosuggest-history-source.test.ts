import { describe, expect, it } from 'vitest'
import {
  createTerminalAutosuggestSessionPool,
  parseShellHistoryContent
} from './terminal-autosuggest-history-source'

describe('createTerminalAutosuggestSessionPool', () => {
  it('returns pushed commands most-recent-first', () => {
    const pool = createTerminalAutosuggestSessionPool()
    pool.push('git status')
    pool.push('git commit -m "x"')
    expect(pool.getAll()).toEqual(['git commit -m "x"', 'git status'])
  })

  it('deduplicates by moving repeats to the front', () => {
    const pool = createTerminalAutosuggestSessionPool()
    pool.push('git status')
    pool.push('ls')
    pool.push('git status')
    expect(pool.getAll()).toEqual(['git status', 'ls'])
  })

  it('caps at maxSize, dropping the oldest', () => {
    const pool = createTerminalAutosuggestSessionPool(2)
    pool.push('a')
    pool.push('b')
    pool.push('c')
    expect(pool.getAll()).toEqual(['c', 'b'])
  })
})

describe('parseShellHistoryContent', () => {
  it('parses plain bash-style history (one command per line)', () => {
    const content = 'git status\nls -la\n'
    expect(parseShellHistoryContent(content, 'bash')).toEqual(['ls -la', 'git status'])
  })

  it('parses zsh extended history format, stripping the timestamp prefix', () => {
    const content = ': 1700000000:0;git status\n: 1700000001:0;ls -la\n'
    expect(parseShellHistoryContent(content, 'zsh')).toEqual(['ls -la', 'git status'])
  })

  it('skips blank lines and malformed zsh lines without throwing', () => {
    const content = ': 1700000000:0;git status\n\nnot-a-valid-zsh-line\n'
    expect(parseShellHistoryContent(content, 'zsh')).toEqual(['not-a-valid-zsh-line', 'git status'])
  })

  it('caps at the most recent 2000 entries', () => {
    const lines = Array.from({ length: 2500 }, (_, i) => `cmd${i}`).join('\n')
    const result = parseShellHistoryContent(lines, 'bash')
    expect(result).toHaveLength(2000)
    expect(result[0]).toBe('cmd2499')
  })
})
