import { setTimeout as delay } from 'node:timers/promises'
import { throwIfSignalAborted, waitForPromiseWithSignal } from '../../abort-signal-reason'
import { readGitCommandFailureStderr } from '../commands/git-command-failure-text'
import { findGitSubcommandIndex } from '../commands/git-command-classification'
import { isExecKilledError, stripCredentialsFromMessage } from '../remotes/git-remote-error'

const REMOTE_REF_CAS_ERROR =
  /^(?:error|fatal): (?:fetching ref refs\/remotes\/[^\s]+ failed: incorrect old value provided|cannot lock ref 'refs\/remotes\/[^'\s]+': is at (?:[0-9a-f]{40}|[0-9a-f]{64}) but expected (?:[0-9a-f]{40}|[0-9a-f]{64}))$/i
const OTHER_GIT_ERROR = /\b(?:error|fatal):|^remote:.*\b(?:error|fatal)\b/i

function remoteRefRaceStderr(error: unknown): string | null {
  if (!(error instanceof Error) || isExecKilledError(error)) {
    return null
  }
  if (
    ('timedOut' in error && error.timedOut === true) ||
    ('outputTruncated' in error && error.outputTruncated === true) ||
    error.name === 'AbortError' ||
    error.name === 'TimeoutError' ||
    error.name === 'GitCommandTimeoutError' ||
    ('code' in error &&
      (error.code === 'ABORT_ERR' ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'))
  ) {
    return null
  }
  const stderr = readGitCommandFailureStderr(error)
  if (!stderr) {
    return null
  }
  let matched = false
  for (const line of stderr.split(/[\r\n]+/)) {
    if (REMOTE_REF_CAS_ERROR.test(line.trim())) {
      matched = true
    } else if (OTHER_GIT_ERROR.test(line.trim())) {
      return null
    }
  }
  return matched ? stderr : null
}

/** Only standalone fetches may be replayed; pull can fail after changing the worktree. */
export async function retryGitFetchRefRace<T>(
  args: readonly string[],
  initialError: unknown,
  attempt: () => Promise<T>,
  terminated: () => Promise<void> | null,
  signal?: AbortSignal
): Promise<T> {
  if (args[findGitSubcommandIndex(args)] !== 'fetch') {
    throw initialError
  }
  let error = initialError
  for (let retry = 0; ; retry += 1) {
    const stderr = remoteRefRaceStderr(error)
    if (stderr === null) {
      throw error
    }
    throwIfSignalAborted(signal)
    if (retry === 2) {
      const detail = stripCredentialsFromMessage(stderr.trim())
      throw new Error(`${detail}\nAnother Git process updated remote references. Try again.`, {
        cause: initialError
      })
    }
    await waitForPromiseWithSignal(terminated() ?? Promise.resolve(), signal)
    await delay(50 + retry * 100 + Math.floor(Math.random() * 50), undefined, { signal })
    throwIfSignalAborted(signal)
    try {
      return await attempt()
    } catch (nextError) {
      error = nextError
    }
  }
}
