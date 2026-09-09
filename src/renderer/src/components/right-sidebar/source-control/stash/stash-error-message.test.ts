import { describe, expect, it } from 'vitest'
import { getStashErrorMessage } from './stash-error-message'

describe('stash error messages', () => {
  it.each([
    [
      'stash_revision_changed',
      'This stash changed. Refresh stashes and try again.'
    ],
    ['invalid_stash_revision', 'Invalid stash revision'],
    [
      'git_stash_unavailable',
      'Git stashes are unavailable on this host. Reconnect to update Orca, then try again.'
    ]
  ])('unwraps Electron IPC errors for %s', (code, expected) => {
    const error = new Error(`Error invoking remote method 'git:stashApply': Error: ${code}`)
    expect(getStashErrorMessage(error, 'Fallback')).toBe(expected)
  })

  it('returns the fallback for non-errors', () => {
    expect(getStashErrorMessage(null, 'Fallback')).toBe('Fallback')
  })
})
