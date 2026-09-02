import { PANEL_DESIGN_TOKEN_ALLOWLIST } from '../../../../shared/plugins/plugin-panel-shell'

/**
 * Snapshots the curated design-token subset from the live document so panel
 * documents can match the app without any access to it. Values are read from
 * computed styles (trusted origin) but still stripped of structural CSS
 * characters before landing inside the shell's <style> block.
 */
export function buildPanelDesignTokenCss(): string {
  const styles = getComputedStyle(document.documentElement)
  const declarations: string[] = []
  for (const token of PANEL_DESIGN_TOKEN_ALLOWLIST) {
    const value = styles.getPropertyValue(token).trim()
    if (value.length > 0) {
      declarations.push(`${token}:${value.replaceAll(/[{}<>;]/g, '')}`)
    }
  }
  return declarations.join(';')
}

export function currentPanelColorScheme(): 'light' | 'dark' {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}
