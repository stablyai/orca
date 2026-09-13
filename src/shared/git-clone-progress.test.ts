import { describe, expect, it } from 'vitest'
import { parseGitCloneProgress } from './git-clone-progress'

describe('parseGitCloneProgress', () => {
  it('parses a percentage-bearing progress line', () => {
    expect(parseGitCloneProgress('Receiving objects:  42% (420/1000)')).toEqual([
      { phase: 'Receiving objects', percent: 42 }
    ])
  })

  it('yields nothing for early phases without a percentage', () => {
    expect(parseGitCloneProgress('remote: Enumerating objects: 1000, done.')).toEqual([])
    expect(parseGitCloneProgress("Cloning into 'repo'...")).toEqual([])
    expect(parseGitCloneProgress('')).toEqual([])
  })

  it('parses multiple \\r-overwritten fragments in one chunk', () => {
    const chunk = 'Receiving objects:  10% (100/1000)\rReceiving objects:  55% (550/1000)\r'
    expect(parseGitCloneProgress(chunk)).toEqual([
      { phase: 'Receiving objects', percent: 10 },
      { phase: 'Receiving objects', percent: 55 }
    ])
  })

  it('handles multi-word phases and the terminal 100%', () => {
    expect(parseGitCloneProgress('Resolving deltas: 100% (300/300), done.')).toEqual([
      { phase: 'Resolving deltas', percent: 100 }
    ])
  })

  it('ignores remote:-prefixed lines (anchored regex matches client-side phases only)', () => {
    // Why: git prefixes server-side counting/compressing with "remote: "; the
    // ^-anchored regex can't span that first colon, so only the un-prefixed
    // client phases (Receiving/Resolving) surface — matching prior behavior.
    const chunk = 'remote: Compressing objects: 100% (50/50)\nReceiving objects:  20% (2/10)\n'
    expect(parseGitCloneProgress(chunk)).toEqual([{ phase: 'Receiving objects', percent: 20 }])
  })
})
