import zoomLogo from '@/assets/connector-brands/zoom.png'

// The tile each logo is drawn on, where it isn't the plain white one: the colour the brand itself sits on.
// `brand`: Orca's bundled marks, by connector or BOT_MCP_APPS id, drawn mark-sized on the tile.
// `composio`: logos Composio serves that are a full square of one colour (Composio's own is black),
// drawn edge to edge so the square is the tile rather than a small square on white. A square with see-through
// holes (Trello's columns) gets the colour the holes should show: white.
// `filled`: full-square app icons Orca bundles in place of the logo Composio serves (Zoom's is a small round mark).
// Ids appear in both because the two images differ: Composio's Stripe is a purple square, ours a purple mark.

/** The near-black tile a white monochrome mark is drawn on. */
const DARK_TILE = 'var(--brand-mark-foreground)'

export const LOGO_TILES: {
  readonly brand: Readonly<Record<string, string>>
  readonly composio: Readonly<Record<string, string>>
  readonly filled: Readonly<Record<string, string>>
} = {
  brand: {
    linear: DARK_TILE,
    vercel: DARK_TILE,
    sentry: '#362d59',
    context7: '#007a55',
    neon: '#000000',
    supabase: '#1c1c1c',
    granola: '#b2c248',
    intercom: DARK_TILE
  },
  composio: {
    composio: '#000000',
    box: '#0061d5',
    context7: '#007a55',
    dropbox: '#0061fe',
    figma: '#000000',
    hubspot: '#ff4800',
    miro: '#ffdd33',
    neon: '#000000',
    netlify: '#ffffff',
    playwright: '#f1f1f2',
    posthog: '#000000',
    sentry: '#572b9d',
    stripe: '#533afd',
    supabase: '#1c1c1c',
    trello: '#ffffff',
    vercel: '#000000',
    zendesk: '#12130e',
    zoom: '#0b5cff'
  },
  filled: {
    zoom: zoomLogo
  }
}

/** Composio logos that are one near-black mark on nothing: bare in a connector row, a dark theme draws them white. */
export const COMPOSIO_DARK_MARKS: ReadonlySet<string> = new Set(['github', 'intercom'])
