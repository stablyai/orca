/** What a page says about itself in its <head>, for a chat link's hover card. */
export type LinkPreview = {
  /** The page that answered, after redirects. */
  url: string
  title: string | null
  description: string | null
  siteName: string | null
  /** Fetched by the host through the same address guard; never a URL the renderer loads. */
  imageDataUrl: string | null
  faviconDataUrl: string | null
}

export type LinkPreviewRequest = { url: string }

/** `unavailable` covers blocked addresses, non-HTML responses, timeouts and pages with no title. */
export type LinkPreviewResult = { kind: 'page'; preview: LinkPreview } | { kind: 'unavailable' }

/** Characters held by a preview; data URLs are ASCII, so this tracks its memory closely. */
export function linkPreviewSize(preview: LinkPreview): number {
  return [
    preview.url,
    preview.title,
    preview.description,
    preview.siteName,
    preview.imageDataUrl,
    preview.faviconDataUrl
  ].reduce((total, text) => total + (text?.length ?? 0), 0)
}
