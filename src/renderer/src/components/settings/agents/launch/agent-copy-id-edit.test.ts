import { describe, expect, it } from 'vitest'
import { agentCopyIdPrefix, applyAgentCopyIdEdit, isAgentCopyIdSuffix } from './agent-copy-id-edit'

const prefix = agentCopyIdPrefix('claude')

describe("an agent copy's id field", () => {
  it('fixes the prefix at the agent and a dot', () => {
    expect(prefix).toBe('claude.')
  })

  it('takes only lowercase letters, digits and dashes after the prefix', () => {
    expect(isAgentCopyIdSuffix('claude', 'code-mode')).toBe(true)
    expect(isAgentCopyIdSuffix('claude', 'mode2')).toBe(true)
    expect(isAgentCopyIdSuffix('claude', '')).toBe(false)
    expect(isAgentCopyIdSuffix('claude', 'Code')).toBe(false)
    expect(isAgentCopyIdSuffix('claude', 'code_mode')).toBe(false)
    expect(isAgentCopyIdSuffix('claude', 'claude.code')).toBe(false)
    expect(isAgentCopyIdSuffix('claude', '-code')).toBe(false)
  })

  it('applies typing in the suffix as typed', () => {
    expect(applyAgentCopyIdEdit(prefix, 'claude.code', 'claude.code-', 12)).toEqual({
      suffix: 'code-',
      caret: 12
    })
    expect(applyAgentCopyIdEdit(prefix, 'claude.code', 'claude.cde', 8)).toEqual({
      suffix: 'cde',
      caret: 8
    })
  })

  it('keeps the prefix when a deletion reaches into it', () => {
    // Backspace right after the dot.
    expect(applyAgentCopyIdEdit(prefix, 'claude.abc', 'claudeabc', 6)).toEqual({
      suffix: 'abc',
      caret: 7
    })
    // Delete at the very start.
    expect(applyAgentCopyIdEdit(prefix, 'claude.abc', 'laude.abc', 0)).toEqual({
      suffix: 'abc',
      caret: 7
    })
    // Cutting the whole selected id leaves the prefix.
    expect(applyAgentCopyIdEdit(prefix, 'claude.abc', '', 0)).toEqual({ suffix: '', caret: 7 })
  })

  it('replaces only the suffix when typing over a selection of the whole id', () => {
    expect(applyAgentCopyIdEdit(prefix, 'claude.code-mode', 'x', 1)).toEqual({
      suffix: 'x',
      caret: 8
    })
  })

  it('keeps a typed letter that matches the start of the selection it replaces', () => {
    // Ctrl+A, then `c`: the selection started at 0, so the `c` is new text, not the old one.
    expect(applyAgentCopyIdEdit(prefix, 'claude.abc', 'c', 1, 0)).toEqual({
      suffix: 'c',
      caret: 8
    })
    // `de.ab` selected across the prefix, then `d`.
    expect(applyAgentCopyIdEdit(prefix, 'claude.abc', 'claudc', 5, 4)).toEqual({
      suffix: 'dc',
      caret: 8
    })
    // Without the selection start, the same strings read as a deletion.
    expect(applyAgentCopyIdEdit(prefix, 'claude.abc', 'c', 1)).toEqual({ suffix: '', caret: 7 })
  })

  it('puts the caret after the prefix when an edit inside it changes nothing', () => {
    // Backspace into the prefix of an empty suffix.
    expect(applyAgentCopyIdEdit(prefix, 'claude.', 'claude', 6, 7)).toEqual({
      suffix: '',
      caret: 7
    })
    // Delete before the dot.
    expect(applyAgentCopyIdEdit(prefix, 'claude.abc', 'claudeabc', 6, 6)).toEqual({
      suffix: 'abc',
      caret: 7
    })
  })

  it('pastes a whole id at the suffix start when the caret is in the prefix', () => {
    expect(applyAgentCopyIdEdit(prefix, 'claude.abc', 'claclaude.xyzude.abc', 13, 3)).toEqual({
      suffix: 'xyzabc',
      caret: 10
    })
  })

  it('keeps only the suffix of a pasted whole id', () => {
    // Pasted over the whole selected id.
    expect(applyAgentCopyIdEdit(prefix, 'claude.code-mode', 'claude.xyz', 10)).toEqual({
      suffix: 'xyz',
      caret: 10
    })
    // Pasted into an empty suffix.
    expect(applyAgentCopyIdEdit(prefix, 'claude.', 'claude.claude.xyz', 17)).toEqual({
      suffix: 'xyz',
      caret: 10
    })
    // Pasted at the suffix's start, before existing text the paste also ends with.
    expect(applyAgentCopyIdEdit(prefix, 'claude.c', 'claude.claude.xyzc', 17)).toEqual({
      suffix: 'xyzc',
      caret: 10
    })
    // A whole id whose suffix shares its start with the old one.
    expect(applyAgentCopyIdEdit(prefix, 'claude.code-mode', 'claude.claude-x', 15)).toEqual({
      suffix: 'claude-x',
      caret: 15
    })
  })

  it('drops whitespace from what is typed or pasted', () => {
    expect(applyAgentCopyIdEdit(prefix, 'claude.', 'claude. claude.xyz \n', 20)).toEqual({
      suffix: 'xyz',
      caret: 10
    })
  })

  it('keeps a suffix that a paste in its middle would leave as it is', () => {
    expect(applyAgentCopyIdEdit(prefix, 'claude.ab', 'claude.aXb', 9)).toEqual({
      suffix: 'aXb',
      caret: 9
    })
  })
})
