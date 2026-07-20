import { describe, expect, it } from 'vitest'
import { bestAutosuggestMatch } from './terminal-autosuggest-engine'

describe('bestAutosuggestMatch', () => {
  it('returns the most recent candidate with a matching prefix', () => {
    const candidates = ['git status', 'git commit -m "fix"', 'git status --short']
    expect(bestAutosuggestMatch(candidates, 'git s')).toBe('git status --short')
  })

  it('returns null when no candidate matches the prefix', () => {
    expect(bestAutosuggestMatch(['ls -la', 'pwd'], 'git')).toBeNull()
  })

  it('returns null when the input is empty', () => {
    expect(bestAutosuggestMatch(['ls -la'], '')).toBeNull()
  })

  it('returns null when the best match equals the current input exactly', () => {
    expect(bestAutosuggestMatch(['git status', 'ls'], 'git status')).toBeNull()
  })

  it('is case-sensitive', () => {
    expect(bestAutosuggestMatch(['Git Status'], 'git')).toBeNull()
  })
})
