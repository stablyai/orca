import type { ThemeStudioSeparateScope } from './theme-studio-separate'

/** "--worktree-sidebar" → "worktree sidebar", "terminal.red" → "terminal red". */
function tokenWords(token: string): string {
  return token.replace(/^--/, '').replace(/[-.]/g, ' ')
}

/** History labels in the person's words: they show on the notice and in Settings. */
export function themeStudioSetLabel(assignments: readonly string[]): string {
  const tokens = [...new Set(assignments.map((pair) => tokenWords(pair.split('=')[0] ?? '')))]
  if (tokens.length === 0) {
    return 'Changed colors'
  }
  if (tokens.length === 1) {
    return `Changed the ${tokens[0]} color`
  }
  if (tokens.length === 2) {
    return `Changed the ${tokens[0]} and ${tokens[1]} colors`
  }
  return `Changed ${tokens.length} colors`
}

const SCOPE_WORDS: Record<ThemeStudioSeparateScope, string> = {
  sidebar: 'sidebars',
  tabs: 'tabs',
  cards: 'cards and menus',
  editor: 'editor'
}

export function themeStudioAdjustLabel(
  adjustment: {
    warmth?: number
    hue?: number
    saturation?: number
    lightness?: number
    contrast?: number
  },
  separate?: { scope: ThemeStudioSeparateScope; amount: number }
): string {
  const parts: string[] = []
  const signed = (value: number | undefined, up: string, down: string): void => {
    if (value) {
      parts.push(value > 0 ? up : down)
    }
  }
  signed(adjustment.warmth, 'warmer', 'cooler')
  if (adjustment.hue) {
    parts.push(`hues shifted ${Math.round(adjustment.hue)}°`)
  }
  signed(adjustment.saturation, 'more vivid', 'more muted')
  signed(adjustment.lightness, 'lighter', 'darker')
  signed(adjustment.contrast, 'more contrast', 'less contrast')
  if (separate?.amount) {
    const area = SCOPE_WORDS[separate.scope]
    parts.push(separate.amount > 0 ? `${area} set apart` : `${area} blended in`)
  }
  const text = parts.join(', ') || 'no change'
  return text.charAt(0).toUpperCase() + text.slice(1)
}
