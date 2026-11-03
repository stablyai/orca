const PREPARATION_TIMEOUT_MS = 60_000

// Timed source consumers must never turn a local read into another network request.
export const LOCAL_RELEASE_GIT_ENV = { GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' }

export async function prepareReleaseSnapshotSource(
  repoRoot: string,
  commit: string,
  { timeoutMs = PREPARATION_TIMEOUT_MS } = {}
): Promise<void> {
  const { runProcess } = await import('@orca/process-host')
  const deadline = Date.now() + timeoutMs
  checkoutDiagnostic('prepare-start', commit, deadline)
  const git = async (args: string[], input?: string): Promise<string> => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new Error(`Historical source preparation timed out after ${timeoutMs}ms`)
    }
    const trace = await checkoutFetchTrace()
    const result = await runProcess({
      program: 'git',
      args,
      input,
      cwd: repoRoot,
      env: { ...process.env, ...trace?.env, ...LOCAL_RELEASE_GIT_ENV },
      timeoutMs: remaining,
      maxOutputBytes: 16 * 1024 * 1024,
      killOnOutputLimit: true,
      terminationBarrier: true
    }).finally(() =>
      trace?.finish(commit, args.includes('fetch') ? 'prepare-fetch' : `prepare-${args[0]}`)
    )
    checkoutDiagnostic(
      args.includes('fetch') ? 'prepare-fetch-end' : `prepare-${args[0]}-end`,
      commit,
      deadline
    )
    if (result.timedOut) {
      throw new Error(`Historical source preparation timed out after ${timeoutMs}ms`)
    }
    if (result.code !== 0 || result.outputTruncated) {
      throw new Error(`Historical source preparation failed during git ${args[0]}`)
    }
    return result.stdout
  }
  const missingObjects = async (): Promise<string[]> =>
    (
      await git([
        'rev-list',
        '--objects',
        '--no-object-names',
        '--missing=print',
        `${commit}^{tree}`
      ])
    )
      .split('\n')
      .filter((line) => line.startsWith('?'))
      .map((line) => line.slice(1))

  // Starting at the tree visits this snapshot, not the commit's ancestry.
  const missing = await missingObjects()
  if (missing.length === 0) {
    checkoutDiagnostic('prepare-end', commit, deadline)
    return
  }
  const remotes = await git(['config', '--get-regexp', '^remote[.].*[.]promisor$'])
  const remote = remotes
    .split('\n')
    .map((line) => /^remote\.(.+)\.promisor\s+true$/i.exec(line)?.[1])
    .find(Boolean)
  if (!remote) {
    throw new Error('Historical source preparation found missing objects without a promisor remote')
  }
  await git(
    [
      '-c',
      'maintenance.auto=false',
      '-c',
      'gc.auto=0',
      'fetch',
      '--no-tags',
      '--no-write-fetch-head',
      '--recurse-submodules=no',
      '--filter=blob:none',
      remote,
      '--stdin'
    ],
    `${missing.join('\n')}\n`
  )
  if ((await missingObjects()).length !== 0) {
    throw new Error('Historical source preparation left requested snapshot objects unavailable')
  }
  checkoutDiagnostic('prepare-end', commit, deadline)
}
import { checkoutDiagnostic, checkoutFetchTrace } from './release-checkout-diagnostic.ts'
