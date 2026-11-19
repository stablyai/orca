export function isGitHubUserAttachmentUrl(href: string | undefined): href is string {
  if (!href) {
    return false
  }
  try {
    const url = new URL(href)
    return (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      url.pathname.startsWith('/user-attachments/assets/')
    )
  } catch {
    return false
  }
}
