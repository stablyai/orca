import { describe, expect, it } from 'vitest'
import { findMissingWorkContextError } from './source-control-ai-template-work-context'

describe('findMissingWorkContextError', () => {
  it('accepts a missing template, which falls back to the built-in prompt', () => {
    expect(findMissingWorkContextError('commitMessage', undefined)).toBeNull()
  })

  it('accepts every placeholder spelling the renderer substitutes', () => {
    for (const template of [
      '{basePrompt}',
      'Use Conventional Commits.\n{ stagedFiles }',
      'Diff:\n{{stagedPatch}}',
      '{{ basePrompt }}\n\nFixes #{linkedIssue}'
    ]) {
      expect(findMissingWorkContextError('commitMessage', template)).toBeNull()
    }
  })

  it('names the variables that carry work context for each action', () => {
    expect(findMissingWorkContextError('commitMessage', 'Branch {branch}')).toContain(
      '{stagedPatch}'
    )
    expect(findMissingWorkContextError('pullRequest', 'Base {baseBranch}')).toContain('{patch}')
    expect(findMissingWorkContextError('branchName', 'kebab-case please')).toContain(
      '{firstPrompt}'
    )
  })

  it('does not count {assistantMessage}, which is empty when no agent has replied', () => {
    expect(
      findMissingWorkContextError('branchName', 'Name this: {assistantMessage}')
    ).not.toBeNull()
  })

  it('does not count a variable that belongs to another action', () => {
    expect(findMissingWorkContextError('commitMessage', '{patch}')).not.toBeNull()
    expect(findMissingWorkContextError('pullRequest', '{stagedPatch}')).not.toBeNull()
  })

  it('does not count a misspelled placeholder or a bare variable name', () => {
    expect(findMissingWorkContextError('commitMessage', '{stagedPatches}')).not.toBeNull()
    expect(findMissingWorkContextError('commitMessage', 'stagedPatch')).not.toBeNull()
  })
})
