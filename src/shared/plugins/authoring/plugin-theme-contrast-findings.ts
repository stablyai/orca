import { parsePluginAppThemeArtifact } from '../artifacts/plugin-theme-artifact'
import type { PluginManifest } from '../manifest/plugin-manifest'
import { cssColorProbe } from '../../theme/css-color-probe'
import { splitUncheckedColors } from '../../theme/css-color-unchecked'
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
  /** Valid CSS this check cannot resolve without the app (system colors, relative colors). */
  unchecked?: string[]
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
    // Why set aside: system colors, relative colors and calc() are valid CSS the renderer
    // resolves; this check cannot, so it says so instead of calling them invalid.
    const { checked, unchecked } = splitUncheckedColors(artifact.tokens)
    const { drops } = evaluatePluginThemeTokens(
      checked,
      artifact.base,
      THEME_BUILT_IN_VALUES[artifact.base],
      cssColorProbe
    )
    const at = { theme: theme.id, path: theme.path, base: artifact.base }
    return [
      ...drops.map((drop) => ({ ...at, ...describe(drop) })),
      ...(unchecked.length > 0
        ? [
            {
              ...at,
              dropped: [],
              unchecked,
              message: `not checked: ${unchecked.join(', ')} use CSS only the app can resolve`
            }
          ]
        : [])
    ]
  })
}

/** One line per finding, in the shape of the other strict-check messages. */
export function pluginThemeContrastMessages(
  findings: readonly PluginThemeContrastFinding[]
): string[] {
  return findings
    .filter((finding) => finding.dropped.length > 0)
    .map(
      (finding) =>
        `contributes.themes "${finding.theme}" (${finding.path}): ${finding.message}; Orca keeps its own ${finding.dropped.join(', ')} (contrast)`
    )
}

/** Notes for tokens the check could not resolve; never errors, even under --strict. */
export function pluginThemeContrastNotes(
  findings: readonly PluginThemeContrastFinding[]
): string[] {
  return findings
    .filter((finding) => finding.unchecked)
    .map(
      (finding) =>
        `contributes.themes "${finding.theme}" (${finding.path}): contrast ${finding.message}`
    )
}
