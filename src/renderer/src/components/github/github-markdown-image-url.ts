import { isClipboardTextByteLengthOverLimit } from '../../../../shared/clipboard-text'

export const GITHUB_MARKDOWN_IMAGE_URL_MAX_BYTES = 8 * 1024

export type GitHubMarkdownImageUrlState =
  | { status: 'empty' }
  | { status: 'too-large' }
  | { status: 'invalid' }
  | { status: 'valid'; url: string }

export function isGitHubMarkdownImageUrlTooLarge(
  value: string,
  maxBytes = GITHUB_MARKDOWN_IMAGE_URL_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(value, maxBytes)
}

export function hasBoundedGitHubMarkdownImageUrlText(value: string): boolean {
  return !isGitHubMarkdownImageUrlTooLarge(value) && /\S/.test(value)
}

function isHttpImageUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

export function getGitHubMarkdownImageUrlState(value: string): GitHubMarkdownImageUrlState {
  if (isGitHubMarkdownImageUrlTooLarge(value)) {
    return { status: 'too-large' }
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return { status: 'empty' }
  }
  if (!isHttpImageUrl(trimmed)) {
    return { status: 'invalid' }
  }
  return { status: 'valid', url: trimmed }
}
