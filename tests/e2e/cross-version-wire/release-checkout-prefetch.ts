import { runCheckoutProcess } from './release-checkout-process'

export async function prefetchReleaseBlobs(
  repoRoot: string,
  commit: string,
  paths: string[],
  deadline: number
): Promise<void> {
  const objects = await runCheckoutProcess(
    repoRoot,
    'git',
    [
      'rev-list',
      '--objects',
      '--missing=print',
      '--no-object-names',
      '--no-walk',
      commit,
      '--',
      ...paths
    ],
    deadline,
    { maxOutputBytes: 8 * 1024 * 1024 }
  )
  const missing = objects
    .split('\n')
    .filter((line) => line.startsWith('?'))
    .map((line) => line.slice(1))
  if (missing.length === 0) {
    return
  }
  const remotes = await runCheckoutProcess(
    repoRoot,
    'git',
    ['config', '--get-regexp', '^remote\\..*\\.promisor$'],
    deadline
  )
  const remote = /^remote\.(.+)\.promisor (?:true|1)$/m.exec(remotes)?.[1]
  if (!remote) {
    throw new Error('Historical release blobs are missing without a promisor remote')
  }
  // Archive otherwise fetches cold historical blobs individually in filtered CI clones.
  await runCheckoutProcess(
    repoRoot,
    'git',
    [
      '-c',
      'fetch.negotiationAlgorithm=noop',
      'fetch',
      '--quiet',
      '--no-tags',
      '--recurse-submodules=no',
      '--filter=blob:none',
      '--stdin',
      remote
    ],
    deadline,
    { input: `${missing.join('\n')}\n` }
  )
}
