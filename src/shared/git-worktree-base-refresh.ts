export function buildWorktreeBaseRefreshArgs(localBranch: string, remoteOid: string): string[] {
  if (localBranch.includes('=')) {
    throw new Error('Cannot safely refresh a checked-out base branch containing "=".')
  }
  return [
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'merge.autoStash=false',
    '-c',
    `branch.${localBranch}.mergeOptions=`,
    'merge',
    '--ff-only',
    '--no-overwrite-ignore',
    remoteOid
  ]
}
