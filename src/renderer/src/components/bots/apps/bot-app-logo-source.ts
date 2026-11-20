// Which logo a tool or app is drawn with, wherever tools and apps are listed: a brand Add to <bot> draws,
// else the app's Composio logo, else none (the caller's generic icon).
import { COMPOSIO_CURATED_APPS } from '../../../../../shared/composio/composio-curated-apps'
import { hasBotAppBrand } from './BotAppBrandLogo'

export type BotAppLogoSource = { kind: 'brand'; id: string } | { kind: 'composio'; slug: string }

const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '')

const COMPOSIO_SLUGS = new Map([
  ...COMPOSIO_CURATED_APPS.flatMap((app): [string, string][] => [
    [normalize(app.slug), app.slug],
    [normalize(app.name), app.slug]
  ]),
  // Composio itself, whose own logo it serves too.
  ['composio', 'composio']
])

function sourceForWord(word: string): BotAppLogoSource | null {
  const key = normalize(word)
  if (!key) {
    return null
  }
  if (hasBotAppBrand(key)) {
    return { kind: 'brand', id: key }
  }
  const slug = COMPOSIO_SLUGS.get(key)
  return slug ? { kind: 'composio', slug } : null
}

/** The words of a URL's host, most specific first: mcp.figma.com → mcp, figma. */
function hostWords(detail: string | undefined): string[] {
  if (!detail || !/^https?:\/\//i.test(detail)) {
    return []
  }
  try {
    return new URL(detail).hostname.split('.').slice(0, -1)
  } catch {
    return []
  }
}

/**
 * A tool's logo by its name ("sentry", "Figma"), then by its server's host; a Composio app by its
 * slug. Null when no logo is known, so the caller draws its generic icon.
 */
export function botAppLogoSource(name: string, detail?: string): BotAppLogoSource | null {
  for (const word of [name, ...hostWords(detail)]) {
    const source = sourceForWord(word)
    if (source) {
      return source
    }
  }
  return null
}
