import {
  GITHUB_OWNER_NUMBER_SHORTHAND_RE,
  GITHUB_OWNER_SLUG_RE
} from '../../../../shared/github/owner-slug'
import { isGitHubProjectRefInputTooLarge } from '../../../../shared/github/project-ref-input'

export function parseProjectInput(
  input: string
): { owner: string; number: number; host?: string; viewNumber?: number } | null {
  const trimmed = input.trim()
  if (!trimmed || isGitHubProjectRefInputTooLarge(trimmed)) {
    return null
  }
  const short = GITHUB_OWNER_NUMBER_SHORTHAND_RE.exec(trimmed)
  if (short) {
    const number = Number(short[2])
    return Number.isSafeInteger(number) && number > 0 ? { owner: short[1], number } : null
  }
  try {
    const url = new URL(trimmed)
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username ||
      url.password ||
      !url.host
    ) {
      return null
    }
    const parts = url.pathname.split('/').filter(Boolean)
    const hasView = parts.length === 6 && parts[4] === 'views'
    if (
      (parts[0] === 'orgs' || parts[0] === 'users') &&
      GITHUB_OWNER_SLUG_RE.test(parts[1] ?? '') &&
      parts[2] === 'projects' &&
      (parts.length === 4 || hasView)
    ) {
      const owner = parts[1]
      const number = Number(parts[3])
      const viewNumber = hasView ? Number(parts[5]) : undefined
      if (
        !Number.isSafeInteger(number) ||
        number < 1 ||
        (hasView && (!Number.isSafeInteger(viewNumber) || (viewNumber ?? 0) < 1))
      ) {
        return null
      }
      return { owner, number, host: url.host.toLowerCase(), viewNumber }
    }
  } catch {
    return null
  }
  return null
}
