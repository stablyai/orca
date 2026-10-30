import {
  FRAME_EVENTS,
  type PluginFrameTheme
} from '../../../../shared/plugins/frames/plugin-frame-bridge'
import { pluginEvent } from '../../../../shared/plugins/frames/plugin-protocol'
import {
  PANEL_DESIGN_TOKEN_ALLOWLIST,
  PANEL_SHELL_COLOR_SCHEME_PLACEHOLDER,
  PANEL_SHELL_TOKENS_PLACEHOLDER
} from '../../../../shared/plugins/frames/plugin-panel-shell'

/** Snapshot trusted computed tokens for isolated panels; strip structural CSS characters before inserting into the shell style block. */
export function buildPanelDesignTokenCss(): string {
  const styles = getComputedStyle(document.documentElement)
  const declarations: string[] = []
  for (const token of PANEL_DESIGN_TOKEN_ALLOWLIST) {
    const value = styles.getPropertyValue(token).trim()
    if (value.length > 0) {
      // Why prefixed: bare names collide with a panel's own shadcn/Tailwind variables.
      declarations.push(`--orca-${token.slice(2)}:${value.replaceAll(/[{}<>;]/g, '')}`)
    }
  }
  return declarations.join(';')
}

export function currentPanelColorScheme(): 'light' | 'dark' {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

/** Replace only the first shell placeholders, parsed before plugin content, so plugin echoes stay inert. */
export function fillPluginPanelShell(html: string): string {
  return html
    .replace(PANEL_SHELL_COLOR_SCHEME_PLACEHOLDER, currentPanelColorScheme())
    .replace(PANEL_SHELL_TOKENS_PLACEHOLDER, buildPanelDesignTokenCss())
}

export function currentPluginFrameTheme(): PluginFrameTheme {
  return { colorScheme: currentPanelColorScheme(), tokens: buildPanelDesignTokenCss() }
}

/** Restyles a loaded frame in place; remounting would discard the plugin's state. */
export function postPluginFrameTheme(frameWindow: Window | null | undefined): void {
  frameWindow?.postMessage(pluginEvent(FRAME_EVENTS.theme, currentPluginFrameTheme()), '*')
}
