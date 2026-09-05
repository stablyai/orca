export function normalizeHostedReviewHeadRef(ref: string): string {
  return ref
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\/[^/]+\//, '')
}

export function normalizeHostedReviewBaseRef(ref: string): string {
  const normalized = normalizeHostedReviewHeadRef(ref)
  return normalized.replace(/^(origin|upstream)\//, '')
}

/** Exclude only a remote's direct symbolic HEAD, preserving branches like feature/HEAD. */
export function isRemoteHeadRef(ref: string, remotes: readonly string[] = []): boolean {
  const shortRef = ref.startsWith('refs/remotes/') ? ref.slice('refs/remotes/'.length) : ref
  const remote = [...remotes]
    .sort((left, right) => right.length - left.length)
    .find((candidate) => shortRef.startsWith(`${candidate}/`))
  if (remote) {
    return shortRef.slice(remote.length + 1) === 'HEAD'
  }
  // A stale ref whose remote is no longer configured is unambiguous only in
  // the conventional two-component `<remote>/HEAD` shape.
  return shortRef.split('/').length === 2 && shortRef.endsWith('/HEAD')
}
