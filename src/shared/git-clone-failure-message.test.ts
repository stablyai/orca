import { describe, expect, it } from 'vitest'
import { getGitCloneFailureMessage } from './git-clone-failure-message'

describe('getGitCloneFailureMessage', () => {
  it('turns an existing destination into an actionable message after progress output', () => {
    expect(
      getGitCloneFailureMessage(
        [
          'Cloning into \u001b[32morca\u001b[0m...\r',
          "fatal: destination path 'orca' already exists and is not an empty directory.\n"
        ].join(''),
        { clonePath: '/work/orca' }
      )
    ).toBe(
      'Destination already exists and is not empty: /work/orca. Choose a different parent folder, delete the existing folder, or add the existing repository instead.'
    )
  })

  it('prefers the last fatal line over a trailing fragment', () => {
    expect(
      getGitCloneFailureMessage(
        "fatal: destination path 'orca' already exists and is not an empty directory.\r\nand the repository exists.\n"
      )
    ).toBe(
      'Destination already exists and is not empty: orca. Choose a different parent folder, delete the existing folder, or add the existing repository instead.'
    )
  })

  it('uses the known clone path for relay destination fragments', () => {
    expect(
      getGitCloneFailureMessage('Clone failed: and the repository exists.', {
        clonePath: '/srv/orca'
      })
    ).toBe(
      'Destination already exists and is not empty: /srv/orca. Choose a different parent folder, delete the existing folder, or add the existing repository instead.'
    )
  })

  it('falls back to the last non-empty line', () => {
    expect(getGitCloneFailureMessage('warning: retrying\nnetwork vanished\n')).toBe(
      'network vanished'
    )
  })
})
