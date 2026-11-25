import {
  type HttpLinkSourceOwner,
  resolveLocalhostHttpLinkDisplayUrl
} from '@/lib/browser/navigation/http-link-routing'

export async function formatTerminalUrlTooltip(
  url: string,
  openLinkHint: string,
  sourceOwner: HttpLinkSourceOwner
): Promise<string | null> {
  const labeledUrl = await resolveLocalhostHttpLinkDisplayUrl(url, sourceOwner)
  if (!labeledUrl) {
    return null
  }
  try {
    const originalHost = new URL(url).host
    return `${labeledUrl} (${originalHost}; ${openLinkHint})`
  } catch {
    return `${labeledUrl} (${openLinkHint})`
  }
}
