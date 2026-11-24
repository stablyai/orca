export const JIRA_IMAGE_SCHEME = 'orca-jira-image'
export const JIRA_IMAGE_CAPABILITY = 'jira.attachment-images.v1' as const
export const JIRA_IMAGE_MAX_BYTES = 8 * 1024 * 1024
export const JIRA_IMAGE_MAX_REFERENCES = 24
export const JIRA_IMAGE_MAX_PENDING_READS = 96
export const JIRA_IMAGE_CHUNK_BYTES = 64 * 1024
export type JiraMediaFormat = 'reference'

export function jiraImageReference(url: string | undefined): string | null {
  if (!url) {
    return null
  }
  const match =
    /^orca-jira-image:\/\/attachment\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
      url
    )
  return match?.[1] ?? null
}

export function isJiraImageMimeType(value: string): boolean {
  return /^image\/(?:png|apng|jpeg|jpg|gif|webp|bmp|avif|tiff|x-icon|vnd\.microsoft\.icon)$/.test(
    value
  )
}
