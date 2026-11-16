import { afterEach, describe, expect, it, vi } from 'vitest'
import { getGitCloneFailureMessage } from './git-clone-failure-message'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('getGitCloneFailureMessage', () => {
  it('scrubs credential-bearing clone URLs before surfacing the fatal line', () => {
    // Clone failures echo user URLs and can expose live tokens in dialogs/bug reports.
    const stderr =
      'Cloning into repo...\n' +
      "fatal: repository 'https://user:ghp_secret123@github.com/org/repo.git/' not found\n"

    expect(getGitCloneFailureMessage(stderr)).toBe(
      "fatal: repository 'https://github.com/org/repo.git/' not found"
    )
  })
})
