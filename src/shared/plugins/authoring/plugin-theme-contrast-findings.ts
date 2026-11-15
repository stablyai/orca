import { parsePluginAppThemeArtifact } from '../artifacts/plugin-theme-artifact'
import type { PluginManifest } from '../manifest/plugin-manifest'
import { cssColorProbe } from '../../theme/css-color-probe'
import {
  evaluatePluginThemeTokens,
  type PluginThemeTokenDrop
} from '../../theme/theme-contrast-engine'
import { THEME_BUILT_IN_VALUES } from '../../theme/theme-built-in-values.generated'
import type { PluginArtifactTextReader } from './plugin-strict-artifact-checks'

/** A token Orca will refuse to paint for a theme, found without a browser. */
export type PluginThemeContrastFinding = {
  theme: string
  path: string
  base: 'light' | 'dark'
  /** Tokens left at Orca's own colors because of this check. */
  dropped: string[]
  message: string
}

const ratioText = (ratio: number | null): string =>
  ratio === null ? 'translucent' : `${ratio.toFixed(2)}:1`

function describe(drop: PluginThemeTokenDrop): { dropped: string[]; message: string } {
  switch (drop.kind) {
    case 'invalid':
      return { dropped: [drop.token], message: `${drop.token} "${drop.value}" is not a color` }
    case 'border-alpha':
      return {
        dropped: [drop.token],
        message: `${drop.token} is ${Math.round(drop.alpha * 100)}% opaque, needs at least ${Math.round(drop.min * 100)}%`
      }
    case 'ring':
      return {
        dropped: [drop.token],
        message: `${drop.token} on ${drop.surface} is ${ratioText(drop.ratio)}, needs ${drop.min}:1`
      }
    case 'contrast':
      return {
        dropped: [...drop.dropped],
        message: `${drop.text} on ${drop.surface} is ${ratioText(drop.ratio)}, needs ${drop.min}:1`
      }
  }
}

/**
 * The tokens each app theme loses to Orca's contrast gate, checked against Orca's built-in colors
 * for the theme's base. The renderer runs the same gate when it paints, so a finding here is a
 * color the person will not see.
 */
export function pluginThemeContrastFindings(
  manifest: PluginManifest,
  read: PluginArtifactTextReader
): PluginThemeContrastFinding[] {
  return manifest.contributes.themes.flatMap((theme) => {
    const text = read(theme.path)
    if (text === null) {
      return []
    }
    let artifact: ReturnType<typeof parsePluginAppThemeArtifact>
    try {
      artifact = parsePluginAppThemeArtifact(text, 'strict')
    } catch {
      // Why skip: the strict artifact checks already report a theme that does not parse.
      return []
    }
    const { drops } = evaluatePluginThemeTokens(
      artifact.tokens,
      artifact.base,
      THEME_BUILT_IN_VALUES[artifact.base],
      cssColorProbe
    )
    return drops.map((drop) => {
      const { dropped, message } = describe(drop)
      return { theme: theme.id, path: theme.path, base: artifact.base, dropped, message }
    })
  })
}

/** One line per finding, in the shape of the other strict-check messages. */
export function pluginThemeContrastMessages(
  findings: readonly PluginThemeContrastFinding[]
): string[] {
  return findings.map(
    (finding) =>
      `contributes.themes "${finding.theme}" (${finding.path}): ${finding.message}; Orca keeps its own ${finding.dropped.join(', ')} (contrast)`
  )
}
