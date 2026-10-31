import { z } from 'zod'
import {
  isPlausiblePluginIconSvg,
  parsePluginIconThemeArtifact,
  pluginIconThemeIconRefs
} from '../artifacts/plugin-icon-theme-artifact'
import { parsePluginLanguagePackArtifact } from '../artifacts/plugin-language-pack-artifact'
import type { EnglishSourceLookup } from '../languages/plugin-translation-string-policy'
import {
  parsePluginGrammarArtifact,
  parsePluginLanguageConfiguration
} from '../artifacts/plugin-syntax-artifact'
import { parsePluginTerminalThemeArtifact } from '../artifacts/plugin-terminal-theme-artifact'
import { parsePluginAppThemeArtifact } from '../artifacts/plugin-theme-artifact'
import type { PluginManifest } from '../manifest/plugin-manifest'
import { formatPluginSchemaIssues } from '../manifest/plugin-schema-issues'

/** Reads a plugin file by its manifest path (always `/`); null when it does not exist. */
export type PluginArtifactTextReader = (manifestPath: string) => string | null

const THEME_POINTS = ['themes', 'terminalThemes', 'iconThemes'] as const
const THEME_PARSERS: Record<(typeof THEME_POINTS)[number], (raw: string) => unknown> = {
  themes: (raw) => parsePluginAppThemeArtifact(raw, 'strict'),
  terminalThemes: (raw) => parsePluginTerminalThemeArtifact(raw, 'strict'),
  iconThemes: (raw) => parsePluginIconThemeArtifact(raw, 'strict')
}

// Why: Orca drops an icon theme whose SVG is missing or not an SVG only once a user picks it.
function iconSvgErrors(read: PluginArtifactTextReader, themeText: string | null): string[] {
  if (themeText === null) {
    return []
  }
  let artifact: ReturnType<typeof parsePluginIconThemeArtifact>
  try {
    artifact = parsePluginIconThemeArtifact(themeText, 'strict')
  } catch {
    return []
  }
  const paths = new Set(pluginIconThemeIconRefs(artifact))
  return [...paths].flatMap((path) => {
    const svg = read(path)
    if (svg === null) {
      return [`${path}: file not found`]
    }
    return isPlausiblePluginIconSvg(svg) ? [] : [`${path}: not an SVG image`]
  })
}

function detail(error: unknown, text: string | null): string {
  if (error instanceof z.ZodError) {
    let input: unknown = null
    try {
      input = text === null ? null : JSON.parse(text)
    } catch {
      input = null
    }
    return formatPluginSchemaIssues(error.issues, input)
  }
  return error instanceof Error ? error.message : String(error)
}

function check(read: PluginArtifactTextReader, path: string, parse: (text: string) => void) {
  const text = read(path)
  if (text === null) {
    return 'file not found'
  }
  try {
    parse(text)
    return null
  } catch (error) {
    return detail(error, text)
  }
}

/**
 * Author-time checks of every content artifact, strictly. Why: Orca skips unknown theme tokens,
 * icon slots, protected language-pack copy and unsafe syntax settings at load, so authors would
 * only learn about a typo here.
 */
export function strictPluginArtifactErrors(
  manifest: PluginManifest,
  read: PluginArtifactTextReader,
  // Why optional: the packaged CLI ships no English catalog, so it checks only source-free rules.
  english?: EnglishSourceLookup
): string[] {
  const c = manifest.contributes
  const themeErrors = THEME_POINTS.flatMap((point) =>
    c[point].flatMap((contribution) => {
      const error = check(read, contribution.path, THEME_PARSERS[point])
      return error
        ? [`contributes.${point} "${contribution.id}" (${contribution.path}): ${error}`]
        : []
    })
  )
  const packErrors = c.languagePacks.flatMap((pack) => {
    const error = check(read, pack.path, (text) => {
      const parsed = parsePluginLanguagePackArtifact(text, 'strict', english)
      if (!parsed.ok) {
        throw new Error(parsed.error)
      }
    })
    return error ? [`contributes.languagePacks "${pack.locale}" (${pack.path}): ${error}`] : []
  })
  const syntaxErrors = c.syntaxes.flatMap((syntax) => {
    const grammar = check(read, syntax.path, (text) =>
      parsePluginGrammarArtifact(text, syntax.scopeName)
    )
    const configuration = syntax.configuration
      ? check(read, syntax.configuration, (text) =>
          parsePluginLanguageConfiguration(text, 'strict')
        )
      : null
    return [
      ...(grammar ? [`contributes.syntaxes "${syntax.id}" (${syntax.path}): ${grammar}`] : []),
      ...(configuration
        ? [`contributes.syntaxes "${syntax.id}" (${syntax.configuration}): ${configuration}`]
        : [])
    ]
  })
  const svgErrors = c.iconThemes.flatMap((theme) =>
    iconSvgErrors(read, read(theme.path)).map(
      (error) => `contributes.iconThemes "${theme.id}" (${theme.path}): ${error}`
    )
  )
  return [...themeErrors, ...svgErrors, ...packErrors, ...syntaxErrors]
}
