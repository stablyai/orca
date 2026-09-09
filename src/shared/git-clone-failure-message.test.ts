import { afterEach, describe, expect, it, vi } from 'vitest'
import { getGitCloneFailureMessage } from './git-clone-failure-message'

afterEach(() => {
  vi.restoreAllMocks()
})

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

  it('scrubs credential-bearing clone URLs before surfacing the fatal line', () => {
    // Clone errors echo the URL the user typed — the most likely git error to
    // embed a live token — and the message reaches dialogs and bug reports.
    const stderr =
      'Cloning into repo...\n' +
      "fatal: repository 'https://user:ghp_secret123@github.com/org/repo.git/' not found\n"

    expect(getGitCloneFailureMessage(stderr)).toBe(
      "fatal: repository 'https://github.com/org/repo.git/' not found"
    )
  })

  it('summarizes CRLF-heavy stderr without line-array splitting', () => {
    const splitSpy = vi.spyOn(String.prototype, 'split')
    const stderr = `${'remote: counting objects\r\n'.repeat(10_000)}fatal: repository not found\r\n`

    expect(getGitCloneFailureMessage(stderr)).toBe('fatal: repository not found')

    const usedLineSplit = splitSpy.mock.calls.some(
      ([separator]) =>
        (typeof separator === 'string' && separator === '\n') ||
        (separator instanceof RegExp && separator.source === '\\r?\\n')
    )
    expect(usedLineSplit).toBe(false)
  })

  it('names the non-interactive remote clone when a key could not be offered', () => {
    const stderr =
      "Cloning into 'repo'...\n" +
      'git@github.com: Permission denied (publickey).\n' +
      'fatal: Could not read from remote repository.\n'

    const message = getGitCloneFailureMessage(stderr)

    expect(message).toContain('fatal: Could not read from remote repository.')
    expect(message).toContain('BatchMode=yes')
    expect(message).toContain('ssh-add')
  })

  it('points host key failures at the machine that runs the clone', () => {
    const stderr = 'Host key verification failed.\nfatal: Could not read from remote repository.\n'

    const message = getGitCloneFailureMessage(stderr)

    expect(message).toContain('known_hosts')
    expect(message).not.toContain('ssh-add')
  })

  it('still explains where an unrecognised SSH clone failure ran', () => {
    const stderr =
      'kex_exchange_identification: read: Connection reset by peer\nfatal: Could not read from remote repository.\n'

    expect(getGitCloneFailureMessage(stderr)).toContain('BatchMode=yes')
  })

  it('leaves non-SSH clone failures untouched', () => {
    expect(
      getGitCloneFailureMessage("fatal: repository 'https://github.com/org/repo.git/' not found")
    ).toBe("fatal: repository 'https://github.com/org/repo.git/' not found")
  })

  it('withholds SSH guidance when the failing transport was HTTPS', () => {
    // Git reuses this line for the HTTP remote helper, so the string alone does not prove SSH.
    const stderr =
      'remote: Invalid username or token.\n' +
      "fatal: Authentication failed for 'https://github.com/org/repo.git/'\n" +
      'fatal: Could not read from remote repository.\n'

    expect(getGitCloneFailureMessage(stderr)).not.toContain('BatchMode=yes')
  })

  it('does not repeat the guidance when a relay message is re-parsed', () => {
    const relayMessage = `Clone failed: ${getGitCloneFailureMessage(
      'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n'
    )}`

    const reparsed = getGitCloneFailureMessage(relayMessage)

    expect(reparsed.match(/BatchMode=yes/g)).toHaveLength(1)
  })
})
