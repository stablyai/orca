export const GITHUB_IMAGE_ATTACHMENT_CAPABILITY = 'github.image-attachments.v1' as const
export const GITHUB_IMAGE_MAX_BYTES = 10 * 1024 * 1024
export const GITHUB_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml'
] as const

export class GitHubImageValidationError extends Error {}

export function assertGitHubImage(contentType: string, size: number): void {
  if (!GITHUB_IMAGE_TYPES.some((type) => type === contentType)) {
    throw new GitHubImageValidationError(
      'GitHub images must be PNG, JPEG, GIF, WebP, or SVG. Use an image URL for another format.'
    )
  }
  if (!Number.isSafeInteger(size) || size <= 0 || size > GITHUB_IMAGE_MAX_BYTES) {
    throw new GitHubImageValidationError(
      'GitHub images must be nonempty and no larger than 10 MB. Choose a smaller image.'
    )
  }
}
