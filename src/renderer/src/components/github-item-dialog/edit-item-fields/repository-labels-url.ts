export function getGitHubRepositoryLabelsUrl(itemUrl: string): string | null {
  try {
    const parsed = new URL(itemUrl)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null
    }
    const segments = parsed.pathname.split('/').filter(Boolean)
    if (segments.length < 2) {
      return null
    }
    // Why: preserve the origin so GitHub Enterprise URLs keep working while re-pathing to the repo-scoped labels page.
    parsed.pathname = `/${segments[0]}/${segments[1]}/labels`
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return null
  }
}
