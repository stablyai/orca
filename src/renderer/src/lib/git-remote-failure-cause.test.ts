import { execFile } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'
import { normalizeGitErrorMessage } from '../../../shared/git-remote-error'
import { resolveRemoteOperationErrorMessage } from './source-control-remote-error'

const execFileAsync = promisify(execFile)

/**
 * The bytes OpenSSH itself writes ahead of a `publickey` denial when the configured identity
 * is missing, transcribed from a live `git push` to github.com (OpenSSH 9.x, macOS). The
 * denial is never the first line: ssh names the unreadable key file — under the user's home
 * directory — before it gets there.
 */
const REAL_SSH_MISSING_IDENTITY_STDERR = [
  'Warning: Identity file /Users/example/.ssh/id_ed25519 not accessible: No such file or directory.',
  "Warning: Permanently added 'github.com' (ED25519) to the list of known hosts.",
  'git@github.com: Permission denied (publickey).'
]

/**
 * Likewise for a changed host key, transcribed from a live `git push` against a deliberately
 * wrong pinned key. ssh's verdict is last; everything before it is a banner, a fingerprint,
 * and two lines naming a local `known_hosts` path.
 */
const REAL_SSH_HOST_KEY_CHANGED_STDERR = [
  '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
  '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @',
  '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
  'IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!',
  'Someone could be eavesdropping on you right now (man-in-the-middle attack)!',
  'It is also possible that a host key has just been changed.',
  'The fingerprint for the ED25519 key sent by the remote host is',
  'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU.',
  'Please contact your system administrator.',
  'Add correct host key in /Users/example/.ssh/known_hosts to get rid of this message.',
  'Offending ED25519 key in /Users/example/.ssh/known_hosts:1',
  'Host key for github.com has changed and you have requested strict checking.',
  'Host key verification failed.'
]

/**
 * What a current OpenSSH writes when a configured identity is missing, captured verbatim from
 * OpenSSH_10.2p1 against a real sshd. Note it is *not* `Warning:`-prefixed — the `Warning: Identity
 * file …` wording above belongs to older releases — so no prefix tells advisories apart from verdicts.
 */
const REAL_SSH_NO_SUCH_IDENTITY = [
  'no such identity: /Users/example/.ssh/id_ed25519: No such file or directory\r'
]

/**
 * Likewise for a private key with loose permissions: seven lines, the last of which names the key
 * under the user's home and is neither `Warning:`-prefixed nor a verdict.
 */
const REAL_SSH_UNPROTECTED_KEY = [
  '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r',
  '@         WARNING: UNPROTECTED PRIVATE KEY FILE!          @\r',
  '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r',
  "Permissions 0644 for '/Users/example/.ssh/id_ed25519' are too open.\r",
  'It is required that your private key files are NOT accessible by others.\r',
  'This private key will be ignored.\r',
  'Load key "/Users/example/.ssh/id_ed25519": bad permissions\r'
]

/**
 * Real `git push`/`git fetch` failures, not stubs: a fake GIT_SSH_COMMAND replays what a real
 * ssh wrote, so git itself writes the two-part stderr (cause first, generic "and the repository
 * exists." advice last) this suite is about. No network — the fake ssh never connects.
 */
async function runFailingGitRemoteOperation(
  subcommand: 'push' | 'fetch',
  sshStderr: readonly string[] = ['git@github.com: Permission denied (publickey).']
): Promise<Error> {
  const dir = mkdtempSync(join(tmpdir(), 'orca-git-remote-failure-'))
  const ssh = join(dir, 'fake-ssh.sh')
  writeFileSync(
    ssh,
    `#!/bin/sh\ncat >&2 <<'ORCA_SSH_STDERR'\n${sshStderr.join('\n')}\nORCA_SSH_STDERR\nexit 255\n`
  )
  chmodSync(ssh, 0o755)
  const git = (args: string[]): Promise<unknown> => execFileAsync('git', args, { cwd: dir })
  await git(['init', '-q'])
  await git(['config', 'user.email', 'test@example.com'])
  await git(['config', 'user.name', 'Test'])
  writeFileSync(join(dir, 'a.txt'), 'hi\n')
  await git(['add', 'a.txt'])
  await git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'init'])
  await git(['remote', 'add', 'origin', 'git@github.com:acme/repo.git'])
  const args =
    subcommand === 'push' ? ['push', '--set-upstream', 'origin', 'HEAD'] : ['fetch', '--prune']
  try {
    await execFileAsync('git', args, {
      cwd: dir,
      env: { ...process.env, GIT_SSH_COMMAND: ssh, GIT_TERMINAL_PROMPT: '0' }
    })
  } catch (error) {
    return error as Error
  }
  throw new Error(`git ${subcommand} unexpectedly succeeded`)
}

/**
 * The other half of the matrix: a transport that *works*. The fake ssh writes the same real advisory
 * and then executes the git service it was handed, against a real local repo — so the connection is
 * made, the ref advertisement arrives, and the failure that follows is git's own.
 */
async function runGitFailureOverWorkingTransport(sshStderr: readonly string[]): Promise<Error> {
  const dir = mkdtempSync(join(tmpdir(), 'orca-git-transport-ok-'))
  const ssh = join(dir, 'fake-ssh.sh')
  writeFileSync(
    ssh,
    `#!/bin/sh\ncat >&2 <<'ORCA_SSH_STDERR'\n${sshStderr.join('\n')}\nORCA_SSH_STDERR\nfor orca_last; do :; done\nexec /bin/sh -c "$orca_last"\n`
  )
  chmodSync(ssh, 0o755)
  const git = (args: string[], cwd: string): Promise<unknown> => execFileAsync('git', args, { cwd })
  await git(['init', '-q', '--bare', 'remote.git'], dir)
  await git(['init', '-q', 'work'], dir)
  const work = join(dir, 'work')
  await git(['config', 'user.email', 'test@example.com'], work)
  await git(['config', 'user.name', 'Test'], work)
  writeFileSync(join(work, 'a.txt'), 'hi\n')
  await git(['add', 'a.txt'], work)
  await git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'init'], work)
  await git(['remote', 'add', 'origin', `git@github.com:${join(dir, 'remote.git')}`], work)
  const env = { ...process.env, GIT_SSH_COMMAND: ssh, GIT_TERMINAL_PROMPT: '0' }
  // Proves the transport works: this one has to succeed through the same fake ssh.
  await execFileAsync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/main'], { cwd: work, env })
  try {
    await execFileAsync('git', ['fetch', 'origin', 'refs/heads/does-not-exist'], { cwd: work, env })
  } catch (error) {
    return error as Error
  }
  throw new Error('git fetch unexpectedly succeeded')
}

/** Electron rewraps every rejected `ipcMain.handle` before the renderer reads it. */
function asRendererSeesIt(channel: string, message: string): Error {
  return new Error(`Error invoking remote method '${channel}': Error: ${message}`)
}

const CAUSE = 'Permission denied (publickey)'
const GENERIC_TAIL = 'and the repository exists.'

describe('a failing git remote operation keeps its cause', () => {
  let pushFailure: Error
  let fetchFailure: Error

  beforeAll(async () => {
    ;[pushFailure, fetchFailure] = await Promise.all([
      runFailingGitRemoteOperation('push'),
      runFailingGitRemoteOperation('fetch')
    ])
  }, 60_000)

  it('git really did print the cause first and the generic advice last', () => {
    const stderr = (pushFailure as Error & { stderr?: string }).stderr ?? ''
    expect(stderr).toContain(CAUSE)
    expect(stderr.trimEnd().endsWith(GENERIC_TAIL)).toBe(true)
  })

  it.each([
    ['push', 'git:push', { isPush: true }],
    ['fetch', 'git:fetch', { isFetch: true }],
    ['pull', 'git:pull', undefined]
  ] as const)('surfaces the cause to the %s toast', (operation, channel, options) => {
    const failure = operation === 'fetch' ? fetchFailure : pushFailure
    const produced = normalizeGitErrorMessage(failure, operation)

    // The producer must not decide which half of git's output the user needs.
    expect(produced).toContain(CAUSE)

    const toast = resolveRemoteOperationErrorMessage(asRendererSeesIt(channel, produced), options)
    expect(toast).toContain(CAUSE)
    expect(toast).not.toContain('Error invoking remote method')
  })

  it('reads as one sentence when git’s own line already ends in a period', () => {
    const toast = resolveRemoteOperationErrorMessage(
      asRendererSeesIt('git:push', normalizeGitErrorMessage(pushFailure, 'push')),
      { isPush: true }
    )
    expect(toast).toContain(`${CAUSE}. Check your remote access`)
    expect(toast).not.toContain('..')
  })

  describe('what real ssh prints ahead of its verdict is not the verdict', () => {
    it('surfaces the denial, not the unreadable-identity warning naming a home path', async () => {
      const failure = await runFailingGitRemoteOperation('push', REAL_SSH_MISSING_IDENTITY_STDERR)
      const toast = resolveRemoteOperationErrorMessage(
        asRendererSeesIt('git:push', normalizeGitErrorMessage(failure, 'push')),
        { isPush: true }
      )

      expect(toast).toBe(
        `Push failed. git@github.com: ${CAUSE}. Check your remote access and try again.`
      )
      // A file-permissions warning is not the reason the push failed, and it carries the
      // user's home directory into a toast.
      expect(toast).not.toContain('Identity file')
      expect(toast).not.toContain('/Users/example')
    })

    it('surfaces the host-key verdict, not the banner or the known_hosts path', async () => {
      const failure = await runFailingGitRemoteOperation('fetch', REAL_SSH_HOST_KEY_CHANGED_STDERR)
      const toast = resolveRemoteOperationErrorMessage(
        asRendererSeesIt('git:fetch', normalizeGitErrorMessage(failure, 'fetch')),
        { isFetch: true }
      )

      expect(toast).toBe('Fetch failed. Host key verification failed.')
      expect(toast).not.toContain('@@@')
      expect(toast).not.toContain('/Users/example')
    })
  })

  describe('when the transport worked, the failure git names is git’s own', () => {
    const GIT_VERDICT = "couldn't find remote ref refs/heads/does-not-exist"

    it.each([
      ['a missing identity file', REAL_SSH_NO_SUCH_IDENTITY],
      ['a key with loose permissions', REAL_SSH_UNPROTECTED_KEY]
    ] as const)(
      'shows it, not what ssh said on the way past (%s)',
      async (_case, advisory) => {
        const failure = await runGitFailureOverWorkingTransport(advisory)
        const produced = normalizeGitErrorMessage(failure, 'fetch')

        // The producer still hands on everything, so the log keeps the advisory too.
        expect(produced).toContain('/Users/example')

        for (const [channel, options] of [
          ['git:fetch', { isFetch: true }],
          ['git:push', { isPush: true }],
          ['git:pull', undefined]
        ] as const) {
          const toast = resolveRemoteOperationErrorMessage(
            asRendererSeesIt(channel, produced),
            options
          )

          expect(toast).toContain(GIT_VERDICT)
          // ssh's advisories are the only lines here that name the user's home, and none of them
          // is the reason the fetch failed.
          expect(toast).not.toContain('/Users/example')
        }
      },
      60_000
    )

    it('is not a matter of recognising ssh: git’s own progress line loses too', () => {
      // Real `git pull` output over a working transport. `From …` and `* branch … -> FETCH_HEAD`
      // are git's, printed on a non-tty, and sit between the advisory and the verdict.
      const produced = [
        'no such identity: /Users/example/.ssh/id_ed25519: No such file or directory\r',
        'From ssh://git@github.com/acme/repo',
        ' * branch            main       -> FETCH_HEAD',
        'fatal: refusing to merge unrelated histories'
      ].join('\n')

      expect(resolveRemoteOperationErrorMessage(asRendererSeesIt('git:pull', produced))).toBe(
        'refusing to merge unrelated histories'
      )
    })

    it('keeps the advisory out of the fallback that runs when no line stood out', () => {
      // Captured from a real `git fetch` whose remote-ref directory was not writable: no `fatal:`
      // and no `remote:` line at all, so the scan finds no candidate and the raw fallback runs.
      // Every line but the last names a path; two of them are under the user's home.
      const produced = [
        'no such identity: /Users/example/.ssh/id_ed25519: No such file or directory\r',
        "error: cannot lock ref 'refs/remotes/origin/newbr': Unable to create " +
          "'/Users/example/repo/.git/refs/remotes/origin/newbr.lock': Permission denied",
        'From ssh://git@github.com/acme/repo',
        ' ! [new branch]      newbr      -> origin/newbr  (unable to update local ref)'
      ].join('\n')

      const toast = resolveRemoteOperationErrorMessage(asRendererSeesIt('git:fetch', produced), {
        isFetch: true
      })

      expect(toast).toBe(
        'Fetch failed. ! [new branch]      newbr      -> origin/newbr  (unable to update local ref)'
      )
      expect(toast).not.toContain('/Users/example')
    })
  })

  it('does not leave the user reading only git’s closing advice', () => {
    const toast = resolveRemoteOperationErrorMessage(
      asRendererSeesIt('git:push', normalizeGitErrorMessage(pushFailure, 'push')),
      { isPush: true }
    )
    expect(toast).not.toBe(`Push failed. ${GENERIC_TAIL} Check your remote access and try again.`)
    expect(toast).not.toBe('Push failed. Check your connection and try again.')
  })
})
