import type { CSSProperties } from 'react'
import {
  DEFAULT_TERMINAL_DIVIDER_DARK,
  normalizeColor,
  resolveEffectiveTerminalAppearance
} from '@/lib/terminal-theme'
import {
  isTerminalBackgroundLight,
  resolveOpaqueTerminalBackground
} from '../../../../../shared/terminal-themes/terminal-title-contrast'
import type { TerminalPaneMobileController } from '../controller/use-terminal-pane-mobile-actions'

export function resolveTerminalPaneAppearance({
  isVisible,
  settings,
  shouldMeasureHiddenStartup,
  systemPrefersDark
}: Pick<
  TerminalPaneMobileController,
  'isVisible' | 'settings' | 'shouldMeasureHiddenStartup' | 'systemPrefersDark'
>) {
  const effectiveAppearance = settings
    ? resolveEffectiveTerminalAppearance(settings, systemPrefersDark)
    : null
  const terminalBackground = effectiveAppearance?.theme?.background
  const titleUsesLightSurface = isTerminalBackgroundLight(terminalBackground, {
    appSurface: effectiveAppearance?.mode,
    backgroundOpacity: settings?.terminalBackgroundOpacity
  })
  const paneTitleBackground =
    resolveOpaqueTerminalBackground(terminalBackground, {
      appSurface: effectiveAppearance?.mode,
      backgroundOpacity: settings?.terminalBackgroundOpacity
    }) ?? (titleUsesLightSurface ? '#ffffff' : '#000000')
  const terminalContentVisible = isVisible || shouldMeasureHiddenStartup
  const hiddenStartupStyle: CSSProperties = shouldMeasureHiddenStartup
    ? { opacity: 0, pointerEvents: 'none' }
    : {}
  const terminalContainerStyle: CSSProperties = {
    display: terminalContentVisible ? 'flex' : 'none',
    overflow: 'hidden',
    ...hiddenStartupStyle,
    ['--orca-terminal-divider-color' as string]:
      effectiveAppearance?.dividerColor ?? DEFAULT_TERMINAL_DIVIDER_DARK,
    ['--orca-terminal-divider-color-strong' as string]: normalizeColor(
      effectiveAppearance?.dividerColor,
      DEFAULT_TERMINAL_DIVIDER_DARK
    )
  }
  return {
    effectiveAppearance,
    terminalBackground,
    titleUsesLightSurface,
    paneTitleBackground,
    terminalContentVisible,
    hiddenStartupStyle,
    terminalContainerStyle
  }
}
