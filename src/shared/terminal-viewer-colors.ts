/**
 * The OSC 10/11 colours a viewer paints a terminal with, computed from saved settings alone.
 * Derived from the same attribute composition the renderer publishes, so main's seed is
 * byte-identical to what the renderer later reports: a mismatch would read as a theme change
 * to every PTY owner and drop the colours running TUIs set themselves.
 */
import type { GlobalSettings } from './global-settings-types'
import type { TerminalOscColorQueryReplyColors } from './terminal-osc-color-reply'
import type { TerminalThemeSelectionSettings } from './terminal-theme-selection'
import { terminalViewColorQueryReplyColors } from './terminal-view-attributes'
import {
  resolveTerminalViewAttributes,
  type TerminalViewAttributesRepo
} from './terminal-view-attributes-composition'
import { resolveRepoTerminalViewAttributesByHost } from './repo-terminal-view-attributes-by-host'

export type TerminalViewerColorSettings = TerminalThemeSelectionSettings &
  Pick<
    GlobalSettings,
    'terminalCustomThemes' | 'terminalColorOverrides' | 'terminalBackgroundOpacity'
  >

export type TerminalViewerColors = Required<TerminalOscColorQueryReplyColors>

/**
 * The foreground/background the host's saved settings paint a terminal with, for answering
 * OSC 10/11 before (or without) a renderer. Opacity is ignored: a colour query reports the
 * opaque theme colour.
 */
export function resolveConfiguredTerminalColors(
  settings: TerminalViewerColorSettings,
  systemPrefersDark: boolean
): TerminalViewerColors {
  return terminalViewColorQueryReplyColors(
    resolveTerminalViewAttributes(settings, systemPrefersDark)
  )
}

export type TerminalViewerColorsRepo = TerminalViewAttributesRepo

/**
 * OSC 10/11 colours per themed project, by the execution host it lives on, from persisted repos
 * and settings: the same projects, with the same values, the renderer's per-project publisher
 * sends once it has loaded. Each host's PTY owner receives only its own host's entry.
 */
export function resolveRepoTerminalViewerColorsByHost(
  settings: TerminalViewerColorSettings,
  repos: readonly TerminalViewerColorsRepo[],
  systemPrefersDark: boolean
): Readonly<Record<string, Readonly<Record<string, TerminalViewerColors>>>> {
  // Why fromEntries: it defines own keys, so a `__proto__` repo id cannot swap the prototype.
  return Object.fromEntries(
    Object.entries(resolveRepoTerminalViewAttributesByHost(settings, repos, systemPrefersDark)).map(
      ([hostId, byRepoId]) => [
        hostId,
        Object.fromEntries(
          Object.entries(byRepoId).map(([repoId, attributes]) => [
            repoId,
            terminalViewColorQueryReplyColors(attributes)
          ])
        )
      ]
    )
  )
}
