// The contrast gate every theme passes before Orca paints it: shared so the renderer, the theme
// studio host and `orca plugin validate` all reach the same verdict.
import {
  pluginAppThemeCssFallback,
  type PluginThemeCssFallbackRule
} from '../plugins/artifacts/plugin-theme-css-fallbacks'
import { contrastRatio, mix, over, type Rgba } from '../color/rgba-contrast'
import {
  BORDERS,
  CONTRAST_RULES,
  MIN_BORDER_ALPHA,
  MIN_RING_CONTRAST,
  RINGS,
  type ContrastRule
} from './theme-contrast-rules'

/** sRGB channels 0-255 and alpha 0-1, or null when the value is not a CSS color. */
export type ColorProbe = (value: string) => Rgba | null

/** The `over` layers painted bottom-up; opaque only when the bottom layer is. */
function paintedLayers(
  layers: ContrastRule['over'],
  effective: (token: string) => Rgba | null
): Rgba | null {
  const stack = typeof layers === 'string' ? [layers] : (layers ?? [])
  return stack.reduceRight<Rgba | null>((below, layer) => {
    const color = effective(layer)
    return color && below?.[3] === 1 ? over(color, below) : color
  }, null)
}

/** A token as main.css paints it: the theme's own color, else its CSS fallback, else built-in. */
export function themeTokenResolver(
  own: (token: string) => Rgba | null | undefined,
  base: 'light' | 'dark',
  builtIns: Readonly<Record<string, string>>,
  probe: ColorProbe
): (token: string) => Rgba | null {
  const builtInColors = new Map<string, Rgba | null>()
  const derived = (rule: PluginThemeCssFallbackRule): Rgba | null => {
    if ('tint' in rule) {
      const hue = effective(rule.tint)
      if (!hue) {
        return null
      }
      if (!rule.into) {
        return [hue[0], hue[1], hue[2], (hue[3] * rule.percent) / 100]
      }
      const into = effective(rule.into)
      return into ? mix(hue, into, rule.percent) : null
    }
    if (!('mixForeground' in rule)) {
      return rule.map(effective).find(Boolean) ?? null
    }
    const foreground = effective('--foreground')
    const into = effective(rule.into ?? '--background')
    return foreground && into ? mix(foreground, into, rule.mixForeground) : null
  }
  function effective(token: string): Rgba | null {
    const color = own(token)
    if (color) {
      return color
    }
    const fallback = pluginAppThemeCssFallback(token, base)
    if (fallback) {
      return derived(fallback)
    }
    if (!builtInColors.has(token)) {
      builtInColors.set(token, builtIns[token] ? probe(builtIns[token]) : null)
    }
    return builtInColors.get(token) ?? null
  }
  return effective
}

/** Why the contrast check left a theme token unpainted. */
export type PluginThemeTokenDrop =
  | { kind: 'invalid'; token: string; value: string }
  | { kind: 'border-alpha'; token: string; value: string; alpha: number; min: number }
  | {
      kind: 'contrast'
      dropped: readonly string[]
      surface: string
      text: string
      /** Null when either side is translucent, which the check refuses outright. */
      ratio: number | null
      min: number
      surfaceColor: Rgba
      textColor: Rgba
    }
  | {
      kind: 'ring'
      token: string
      surface: string
      ratio: number
      min: number
      ringColor: Rgba
      surfaceColor: Rgba
    }

/**
 * The plugin tokens that are safe to paint over the built-in ones for the theme's base, and why
 * each other one was dropped. Checks run on the effective set (plugin values, else what main.css
 * derives from them, else built-in), and dropping a token can expose a value that breaks another
 * pair, so checks repeat until nothing changes. Dropped tokens keep their built-in values.
 */
export function evaluatePluginThemeTokens(
  tokens: Readonly<Record<string, string>>,
  base: 'light' | 'dark',
  builtIns: Readonly<Record<string, string>>,
  probe: ColorProbe
): { safe: Record<string, string>; drops: PluginThemeTokenDrop[] } {
  const drops: PluginThemeTokenDrop[] = []
  const accepted = new Map<string, Rgba>()
  for (const [token, value] of Object.entries(tokens)) {
    const color = probe(value)
    if (!color) {
      drops.push({ kind: 'invalid', token, value })
    } else if (BORDERS.includes(token) && color[3] < MIN_BORDER_ALPHA) {
      drops.push({ kind: 'border-alpha', token, value, alpha: color[3], min: MIN_BORDER_ALPHA })
    } else {
      accepted.set(token, color)
    }
  }
  const effective = themeTokenResolver((token) => accepted.get(token), base, builtIns, probe)
  const drop = (...pair: string[]): boolean =>
    pair.map((token) => accepted.delete(token)).some(Boolean)

  for (let changed = true; changed;) {
    changed = false
    for (const rule of CONTRAST_RULES) {
      const dropped =
        rule.surfaceSource && tokens[rule.surface] === undefined
          ? [...rule.dropped, rule.surfaceSource]
          : rule.dropped
      // Why skip: a check with nothing of the theme's to drop can't change the result, so a
      // theme that sets none of a check's tokens pays no probes for it.
      if (!dropped.some((token) => accepted.has(token))) {
        continue
      }
      const textColor = effective(rule.text)
      const ownSurface = effective(rule.surface)
      const beneath = paintedLayers(rule.over, effective)
      const surfaceColor = ownSurface && beneath?.[3] === 1 ? over(ownSurface, beneath) : ownSurface
      const min =
        rule.noWorseThanOver && beneath?.[3] === 1 && textColor?.[3] === 1
          ? Math.min(rule.min, contrastRatio(beneath, textColor))
          : rule.min
      if (!surfaceColor || !textColor) {
        continue
      }
      const ratio =
        surfaceColor[3] < 1 || textColor[3] < 1 ? null : contrastRatio(surfaceColor, textColor)
      if (ratio === null || ratio < min) {
        const owned = dropped.filter((token) => accepted.has(token))
        if (drop(...dropped)) {
          changed = true
          drops.push({
            kind: 'contrast',
            dropped: owned,
            surface: rule.surface,
            text: rule.text,
            ratio,
            min,
            surfaceColor,
            textColor
          })
        }
      }
    }
    for (const [ring, surface] of RINGS) {
      const ringColor = accepted.get(ring)
      if (!ringColor) {
        continue
      }
      const surfaceColor = effective(surface)
      const ratio = surfaceColor ? contrastRatio(over(ringColor, surfaceColor), surfaceColor) : null
      if (surfaceColor && ratio !== null && ratio < MIN_RING_CONTRAST) {
        changed = drop(ring) || changed
        drops.push({
          kind: 'ring',
          token: ring,
          surface,
          ratio,
          min: MIN_RING_CONTRAST,
          ringColor,
          surfaceColor
        })
      }
    }
  }
  return {
    safe: Object.fromEntries(Object.entries(tokens).filter(([token]) => accepted.has(token))),
    drops
  }
}

/** The plugin tokens that are safe to paint; see evaluatePluginThemeTokens. */
export function safePluginThemeTokens(
  tokens: Readonly<Record<string, string>>,
  base: 'light' | 'dark',
  builtIns: Readonly<Record<string, string>>,
  probe: ColorProbe
): Record<string, string> {
  return evaluatePluginThemeTokens(tokens, base, builtIns, probe).safe
}

/** Each token as main.css paints it for a theme whose tokens already passed safePluginThemeTokens. */
export function paintedThemeColors(
  tokens: Readonly<Record<string, string>>,
  base: 'light' | 'dark',
  builtIns: Readonly<Record<string, string>>,
  probe: ColorProbe
): (token: string) => Rgba | null {
  return themeTokenResolver(
    (token) => (tokens[token] ? probe(tokens[token]) : null),
    base,
    builtIns,
    probe
  )
}
