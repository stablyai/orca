export type GiteaReviewConfigStatus = {
  configured?: boolean
  authenticated?: boolean
  tokenConfigured?: boolean
}

export function isGiteaReviewConfigured(status: GiteaReviewConfigStatus | undefined): boolean {
  if (status?.configured !== true) {
    return false
  }
  if (status.tokenConfigured === true && status.authenticated !== true) {
    return false
  }
  return true
}

type GiteaPreflightFacts = {
  gt?: { installed: boolean; authenticated: boolean }
  gitea?: GiteaReviewConfigStatus
}

/** Gitea is usable through either an authenticated `gt` login or a configured REST token. */
export function isGiteaTaskSourceConfigured(
  preflight: GiteaPreflightFacts | null | undefined
): boolean {
  return preflight?.gt?.authenticated === true || isGiteaReviewConfigured(preflight?.gitea)
}
