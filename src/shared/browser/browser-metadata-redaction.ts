import { redactKagiSessionToken } from './navigation/browser-url'
import type {
  BrowserLoadError,
  BrowserPageConversionOrigin
} from './workspaces/browser-workspace-types'

type BrowserUrlMetadata = {
  url?: string
  title?: string
  faviconUrl?: string | null
  loadError?: BrowserLoadError | null
  convertedFrom?: BrowserPageConversionOrigin | null
  convertedTo?: BrowserPageConversionOrigin | null
}

function redactConversionOrigin<T extends BrowserPageConversionOrigin | null | undefined>(
  origin: T
): T {
  if (origin?.kind !== 'url') {
    return origin
  }
  const url = redactKagiSessionToken(origin.url)
  return url === origin.url ? origin : { ...origin, url }
}

export function redactBrowserMetadata<T extends BrowserUrlMetadata>(metadata: T): T {
  const url = metadata.url === undefined ? undefined : redactKagiSessionToken(metadata.url)
  const title = metadata.title === undefined ? undefined : redactKagiSessionToken(metadata.title)
  const faviconUrl = metadata.faviconUrl
    ? redactKagiSessionToken(metadata.faviconUrl)
    : metadata.faviconUrl
  const loadError = metadata.loadError
  const validatedUrl = loadError ? redactKagiSessionToken(loadError.validatedUrl) : undefined
  const convertedFrom = redactConversionOrigin(metadata.convertedFrom)
  const convertedTo = redactConversionOrigin(metadata.convertedTo)
  if (
    url === metadata.url &&
    title === metadata.title &&
    faviconUrl === metadata.faviconUrl &&
    validatedUrl === loadError?.validatedUrl &&
    convertedFrom === metadata.convertedFrom &&
    convertedTo === metadata.convertedTo
  ) {
    return metadata
  }
  return {
    ...metadata,
    ...(url === metadata.url ? {} : { url }),
    ...(title === metadata.title ? {} : { title }),
    ...(faviconUrl === metadata.faviconUrl ? {} : { faviconUrl }),
    ...(loadError && validatedUrl !== loadError.validatedUrl
      ? { loadError: { ...loadError, validatedUrl } }
      : {}),
    ...(convertedFrom === metadata.convertedFrom ? {} : { convertedFrom }),
    ...(convertedTo === metadata.convertedTo ? {} : { convertedTo })
  }
}
