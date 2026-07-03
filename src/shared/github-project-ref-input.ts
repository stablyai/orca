import { getClipboardTextByteLength, isClipboardTextByteLengthOverLimit } from './clipboard-text'

export const GITHUB_PROJECT_REF_INPUT_MAX_BYTES = 2 * 1024
export const GITHUB_PROJECT_REF_INPUT_TOO_LARGE_ERROR = 'Project reference is too large to resolve.'

export function getGitHubProjectRefInputByteLength(input: string): number {
  return getClipboardTextByteLength(input)
}

export function isGitHubProjectRefInputTooLarge(
  input: string,
  maxBytes = GITHUB_PROJECT_REF_INPUT_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(input, maxBytes)
}

export function hasBoundedGitHubProjectRefInputText(input: string): boolean {
  return !isGitHubProjectRefInputTooLarge(input) && /\S/.test(input)
}
