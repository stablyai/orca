export function browserAnnotationMatchesPageUrl(capturedUrl: string, currentUrl: string): boolean {
  try {
    const captured = new URL(capturedUrl)
    const current = new URL(currentUrl)
    // Capture metadata strips query strings and fragments before leaving the guest.
    current.search = ''
    current.hash = ''
    return captured.href === current.href
  } catch {
    return false
  }
}
