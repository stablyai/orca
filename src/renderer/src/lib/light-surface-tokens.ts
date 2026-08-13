// Canonical values for the light-mode warm ("cream") surface ladder.
// Mirrors the dark elevation ladder: chrome is the white extreme, content
// surfaces step toward a warm off-white. `main.css` :root MUST mirror these
// values (CSS cannot import JS); the ladder test guards the value contract.

/** Editor pane, terminal, and Monaco code-area background in light mode. */
export const LIGHT_CONTENT_SURFACE_HEX = '#f6f4ef'

/** Existing light-mode foreground token values, referenced for contrast tests. */
export const LIGHT_FOREGROUND_HEX = '#0a0a0a'
export const LIGHT_MUTED_FOREGROUND_HEX = '#737373'

/** The full light surface ladder, whitest (chrome) -> most recessed. */
export const LIGHT_SURFACE_LADDER = {
  background: '#fdfcfa',
  card: '#fcfbf8',
  sidebar: '#f8f7f3',
  content: LIGHT_CONTENT_SURFACE_HEX,
  muted: '#f2f1ec'
} as const
