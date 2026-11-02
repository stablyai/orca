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
  tea?: { installed: boolean; authenticated: boolean }
  gitea?: GiteaReviewConfigStatus
}

/** Gitea is usable through either an authenticated `tea` login or a configured REST token. */
export function isGiteaTaskSourceConfigured(
  preflight: GiteaPreflightFacts | null | undefined
): boolean {
  return preflight?.tea?.authenticated === true || isGiteaReviewConfigured(preflight?.gitea)
}
