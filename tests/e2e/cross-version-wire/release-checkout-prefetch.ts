import { runCheckoutProcess } from './release-checkout-process.ts'
import { checkoutDiagnostic } from './release-checkout-diagnostic.ts'

const PREPARATION_TIMEOUT_MS = 60_000

export async function prepareReleaseSnapshotSource(
  repoRoot: string,
  commit: string,
  { timeoutMs = PREPARATION_TIMEOUT_MS } = {}
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  checkoutDiagnostic('prepare-start', commit, deadline)
  const git = (args: string[], input?: string): Promise<string> =>
    runCheckoutProcess(repoRoot, 'git', args, deadline, {
      input,
      maxOutputBytes: 16 * 1024 * 1024,
      timeoutMs
    })
  // Starting at the tree visits this snapshot, not the commit's ancestry.
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
  try {
    const missing = await missingObjects()
    if (missing.length !== 0) {
      const remotes = await git(['config', '--get-regexp', '^remote[.].*[.]promisor$'])
      const remote = /^remote\.(.+)\.promisor (?:true|1)$/m.exec(remotes)?.[1]
      if (!remote) {
        throw new Error('Missing snapshot objects without a promisor remote')
      }
      await git(
        [
          '-c',
          'fetch.negotiationAlgorithm=noop',
          '-c',
          'maintenance.auto=false',
          '-c',
          'gc.auto=0',
          'fetch',
          '--quiet',
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
        throw new Error('Requested snapshot objects remain unavailable')
      }
    }
    checkoutDiagnostic('prepare-end', commit, deadline)
  } catch (error) {
    throw new Error(`Historical source preparation: ${String(error)}`)
  }
}
