import { describe, expect, it } from 'vitest'
import {
  formatWorkspaceCreateError,
  getWorkspaceCreateErrorToastMessage
} from './workspace-create-error-format'

describe('formatWorkspaceCreateError', () => {
  it('returns guidance for missing default base ref failures', () => {
    const error = new Error(
      'Could not resolve a default base ref for this repo. Pick a base branch explicitly and try again.'
    )

    const formatted = formatWorkspaceCreateError(error)

    expect(formatted).toEqual({
      title: 'No base branch found',
      message: 'Orca could not resolve a usable base ref for this workspace.',
      help: 'Create an initial commit (for example on main), or select an existing branch in Create From, then try again.'
    })
    expect(getWorkspaceCreateErrorToastMessage(formatted)).toBe('No base branch found')
  })

  it('matches missing base ref failures case-insensitively', () => {
    const formatted = formatWorkspaceCreateError(
      new Error('COULD NOT RESOLVE A DEFAULT BASE REF from remote provider')
    )

    expect(formatted.title).toBe('No base branch found')
    expect(formatted.help).toBeDefined()
  })

  it('passes unknown errors through unchanged', () => {
    const formatted = formatWorkspaceCreateError(new Error('fatal: not a git repository'))

    expect(formatted).toEqual({
      title: 'fatal: not a git repository',
      message: 'fatal: not a git repository'
    })
    expect(getWorkspaceCreateErrorToastMessage(formatted)).toBe('fatal: not a git repository')
  })
})
