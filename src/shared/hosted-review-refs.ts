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
