import { redactKagiSessionToken } from './navigation/browser-url'
import type {
  BrowserLoadError,
  BrowserCertificateFailure,
  BrowserPageConversionOrigin
} from './workspaces/browser-workspace-types'

type BrowserUrlMetadata = {
  url?: string
  title?: string
  faviconUrl?: string | null
  sanitizedUrl?: string
  loadError?: BrowserLoadError | null
  convertedFrom?: BrowserPageConversionOrigin | null
  convertedTo?: BrowserPageConversionOrigin | null
  certificateFailure?: BrowserCertificateFailure | null
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
  const sanitizedUrl =
    metadata.sanitizedUrl === undefined ? undefined : redactKagiSessionToken(metadata.sanitizedUrl)
  const faviconUrl = metadata.faviconUrl
    ? redactKagiSessionToken(metadata.faviconUrl)
    : metadata.faviconUrl
  const loadError = metadata.loadError
  const validatedUrl = loadError ? redactKagiSessionToken(loadError.validatedUrl) : undefined
  const convertedFrom = redactConversionOrigin(metadata.convertedFrom)
  const convertedTo = redactConversionOrigin(metadata.convertedTo)
  const certificateFailure = metadata.certificateFailure
  const origin = certificateFailure ? redactKagiSessionToken(certificateFailure.origin) : undefined
  if (
    url === metadata.url &&
    title === metadata.title &&
    sanitizedUrl === metadata.sanitizedUrl &&
    faviconUrl === metadata.faviconUrl &&
    validatedUrl === loadError?.validatedUrl &&
    convertedFrom === metadata.convertedFrom &&
    convertedTo === metadata.convertedTo &&
    origin === certificateFailure?.origin
  ) {
    return metadata
  }
  return {
    ...metadata,
    ...(url === metadata.url ? {} : { url }),
    ...(title === metadata.title ? {} : { title }),
    ...(sanitizedUrl === metadata.sanitizedUrl ? {} : { sanitizedUrl }),
    ...(faviconUrl === metadata.faviconUrl ? {} : { faviconUrl }),
    ...(loadError && validatedUrl !== loadError.validatedUrl
      ? { loadError: { ...loadError, validatedUrl } }
      : {}),
    ...(convertedFrom === metadata.convertedFrom ? {} : { convertedFrom }),
    ...(convertedTo === metadata.convertedTo ? {} : { convertedTo }),
    ...(certificateFailure && origin !== certificateFailure.origin
      ? { certificateFailure: { ...certificateFailure, origin } }
      : {})
  }
}

export function redactBrowserMetadataGetter(what: unknown, value: unknown): unknown {
  if (what !== 'url' && what !== 'title') {
    return value
  }
  if (typeof value === 'string') {
    return redactKagiSessionToken(value)
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  // Literal keys narrow `in` for every project's compiler settings.
  let raw: unknown
  if (what === 'url' && 'url' in value) {
    raw = value.url
  } else if (what === 'title' && 'title' in value) {
    raw = value.title
  }
  if (typeof raw !== 'string') {
    return value
  }
  const safe = redactKagiSessionToken(raw)
  return safe === raw ? value : { ...value, [what]: safe }
}
