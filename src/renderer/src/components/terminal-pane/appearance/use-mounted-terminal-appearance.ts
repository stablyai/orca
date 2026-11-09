import { useEffect } from 'react'
import { applyTerminalAppearance } from './terminal-appearance'
import { useThemeBackgroundStore } from '@/store/appearance/theme-background'
import { usePluginFontReady } from '@/store/plugins/appearance/plugin-fonts'
import type { UseTerminalPaneLifecycleDeps } from '../mounting/terminal-pane-lifecycle-types'
import type { TerminalPaneLifecycleRefs } from '../mounting/use-terminal-pane-lifecycle-refs'

export function useMountedTerminalAppearance(
  deps: Pick<
    UseTerminalPaneLifecycleDeps,
    | 'repoTerminalTheme'
    | 'repoTerminalThemeRef'
    | 'managerRef'
    | 'settingsRef'
    | 'settings'
    | 'paneTransportsRef'
    | 'effectiveMacOptionAsAltRef'
    | 'paneMode2031Ref'
    | 'paneLastThemeModeRef'
    | 'systemPrefersDark'
    | 'effectiveMacOptionAsAlt'
  >,
  systemPrefersDarkRef: TerminalPaneLifecycleRefs['systemPrefersDarkRef']
): void {
  // Why: a theme image arrives after plugin themes load, so the single-paint switch must re-run then.
  const themeBackgroundActive = useThemeBackgroundStore((state) => state.active)
  // Why: a plugin terminal font joins the font list only once it loads, so cells re-measure then.
  const terminalFontReady = usePluginFontReady(deps.settings?.terminalFontFamily)
  useEffect(() => {
    const manager = deps.managerRef.current
    const currentSettings = deps.settingsRef.current
    if (!manager || !deps.settings || !currentSettings) {
      return
    }
    applyTerminalAppearance(
      manager,
      currentSettings,
      systemPrefersDarkRef.current,
      deps.paneTransportsRef.current,
      deps.effectiveMacOptionAsAltRef.current,
      deps.paneMode2031Ref.current,
      deps.paneLastThemeModeRef.current,
      deps.repoTerminalThemeRef.current
    )
  }, [
    deps.repoTerminalTheme,
    deps.repoTerminalThemeRef,
    deps.settings,
    themeBackgroundActive,
    terminalFontReady,
    deps.systemPrefersDark,
    deps.effectiveMacOptionAsAlt,
    deps.managerRef,
    deps.settingsRef,
    deps.paneTransportsRef,
    deps.effectiveMacOptionAsAltRef,
    deps.paneMode2031Ref,
    deps.paneLastThemeModeRef,
    systemPrefersDarkRef
  ])
}
