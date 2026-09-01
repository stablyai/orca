import type { GlobalSettings } from '../../../shared/global-settings-types'
import { buildSyntaxTokenVariables, resolveTerminalEditorPalette } from './terminal-editor-palette'
import {
  buildSidebarTokenVariables,
  buildSurfaceTextTokenVariables,
  resolveTerminalSurfaceColors,
  type SurfaceStyleVariables,
  type TerminalSurfaceSettings
} from './terminal-surface-colors'

export type WorkspaceChromeAppearanceSettings = TerminalSurfaceSettings &
  Pick<GlobalSettings, 'workspaceChromeAppearanceMode'>

export type WorkspaceChromeStyleVariables = SurfaceStyleVariables

/** Document-root CSS variables that make every app chrome surface (tab strip, status bar, side
 *  panels, full-page views, popovers, editor panes) follow the terminal theme; undefined keeps the app theme.
 *  Left-sidebar appearance modes still win because they scope their own vars below the root. */
export function resolveWorkspaceChromeStyleVariables(
  settings: WorkspaceChromeAppearanceSettings | null | undefined,
  systemPrefersDark: boolean
): WorkspaceChromeStyleVariables | undefined {
  if (!settings || (settings.workspaceChromeAppearanceMode ?? 'default') !== 'match-terminal') {
    return undefined
  }
  const colors = resolveTerminalSurfaceColors(settings, systemPrefersDark)
  const editorPalette = resolveTerminalEditorPalette(settings, systemPrefersDark)
  return {
    // Status bar and titlebars paint this hook ahead of --card.
    '--bg-titlebar': colors.background,
    ...buildSurfaceTextTokenVariables(colors),
    ...buildSidebarTokenVariables(colors),
    // Why: tab surfaces are bg-card; pin it to the terminal background so they don't read as a lighter strip.
    '--card': colors.background,
    // Markdown preview, rich editor, notebooks, and viewers paint --editor-surface; Monaco follows via its own theme.
    '--editor-surface': colors.background,
    ...(editorPalette ? buildSyntaxTokenVariables(editorPalette) : {})
  }
}

type StyleDeclarationLike = Pick<CSSStyleDeclaration, 'setProperty' | 'removeProperty'>

/** Writes `next` onto a root style, clearing whatever the previous call set; returns the keys now applied. */
export function applyWorkspaceChromeStyleVariables(
  style: StyleDeclarationLike,
  next: WorkspaceChromeStyleVariables | undefined,
  previousKeys: readonly string[]
): string[] {
  const nextKeys = next ? Object.keys(next) : []
  for (const key of previousKeys) {
    if (!next || !(key in next)) {
      style.removeProperty(key)
    }
  }
  if (next) {
    for (const key of nextKeys) {
      style.setProperty(key, next[key])
    }
  }
  return nextKeys
}
