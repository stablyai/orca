// Install the import-free hook before react-dom reads it during evaluation; the observer below wraps a per-commit property and can load later.
import './diagnostics/react-commits/react-devtools-commit-hook-shim'
import './diagnostics/react-commits/react-commit-cascade-observer'
import './assets/main.css'

import { StrictMode, useEffect } from 'react'
import { DashboardPopoutRoot } from './components/dashboard-popout/DashboardPopoutRoot'
import { RecoverableRenderErrorBoundary } from './components/error-boundaries/RecoverableRenderErrorBoundary'
import { installRendererCrashDiagnostics } from './diagnostics/crash-reporting/crash-diagnostics'
import { recordRendererCrashBreadcrumb } from './diagnostics/crash-reporting/crash-breadcrumb-recorder'
import { applyDocumentTheme } from './app-shell/appearance/document-theme'
import { resolvePaintedTheme } from './app-shell/appearance/terminal-app-theme'
import { buildAppFontFamily } from './app-shell/appearance/app-font-family'
import { applyCodeFontSmoothing } from './lib/editor/appearance/code-font-smoothing'
import { I18nProvider } from './i18n/I18nProvider'
import { useTranslate } from './i18n/use-translate'
import { useAppStore } from './store/index'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { getOrCreateRendererRoot } from './app-shell/startup/react-renderer-root'
import { setReactCommitCascadeRendererSurface } from './diagnostics/react-commits/react-commit-cascade-telemetry'
import { installOsFileDropCancellationGuard } from './lib/files/drop/os-file-drop-cancellation-guard'
import { installBodyOverlayAttributes } from './lib/overlay-interaction/body-overlay-attributes'
import { useReduceVisualEffects } from './hooks/use-reduce-visual-effects'

const disposeOsFileDropGuard = installOsFileDropCancellationGuard()
import.meta.hot?.dispose(disposeOsFileDropGuard)
const disposeBodyOverlayAttributes = installBodyOverlayAttributes()
import.meta.hot?.dispose(disposeBodyOverlayAttributes)
// Each popout has a separate React root/DOM/JS context; run full renderer bootstrap despite sharing preload/window.api.
recordRendererCrashBreadcrumb('popout_bootstrap_started', { dev: import.meta.env.DEV })
installRendererCrashDiagnostics('dashboard-popout')
setReactCommitCascadeRendererSurface('dashboard-popout')

function applyPopoutAppearance(settings: GlobalSettings | null): void {
  applyDocumentTheme(resolvePaintedTheme(settings), { disableTransitions: false })
  document.documentElement.style.setProperty(
    '--app-font-family',
    buildAppFontFamily(settings?.appFontFamily)
  )
  applyCodeFontSmoothing(settings?.codeFontSmoothing)
}

// Seed this separate store synchronously to prevent OS-theme flash before async appearance hydration.
let startupSettings: GlobalSettings | null = null
try {
  startupSettings = window.api.settings.getSync()
} catch {
  // Async hydration below remains available if the startup read fails.
}
if (startupSettings) {
  useAppStore.setState({ settings: startupSettings })
}
applyPopoutAppearance(startupSettings)

const rootElement = document.getElementById('root')
if (!rootElement) {
  recordRendererCrashBreadcrumb('popout_root_missing')
  throw new Error('Pop-out root element not found.')
}

function PopoutSettingsSync(): null {
  const settings = useAppStore((state) => state.settings)
  useReduceVisualEffects(settings?.reduceVisualEffects)

  useEffect(() => {
    let disposed = false
    // Preview-terminal copy/paste overrides live in a separate keybinding file.
    void useAppStore.getState().fetchKeybindings()
    const offKeybindingsChanged = window.api.keybindings?.onChanged((snapshot) => {
      if (!disposed) {
        useAppStore.getState().setKeybindingSnapshot(snapshot)
      }
    })
    const setSettings = (next: GlobalSettings): void => {
      if (!disposed) {
        useAppStore.setState({ settings: next })
      }
    }
    const offChanged = window.api.settings.onChanged((updates) => {
      const current = useAppStore.getState().settings
      if (current) {
        setSettings({ ...current, ...updates })
      }
    })
    void window.api.settings
      .get()
      .then(setSettings)
      .catch(() => undefined)
    return () => {
      disposed = true
      offChanged()
      offKeybindingsChanged?.()
    }
  }, [])

  useEffect(() => {
    applyPopoutAppearance(settings)
    if (settings?.theme !== 'system') {
      return
    }
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = (): void => applyDocumentTheme(resolvePaintedTheme(settings))
    media.addEventListener('change', handleChange)
    return () => media.removeEventListener('change', handleChange)
  }, [settings])

  return null
}

function PopoutRoot(): React.JSX.Element {
  const t = useTranslate()
  useEffect(() => {
    document.title = t('auto.main.window.dashboard.popout.window.title', 'Orca Agent Dashboard')
  }, [t])
  return (
    <RecoverableRenderErrorBoundary
      boundaryId="dashboard-popout.root"
      surface="dashboard-popout"
      title={t('dashboardPopout.recoverableError.title', 'Orca dashboard hit an error.')}
      description={t(
        'dashboardPopout.recoverableError.description',
        'The dashboard could not finish rendering. Retry to remount it, or reopen it.'
      )}
    >
      <DashboardPopoutRoot />
    </RecoverableRenderErrorBoundary>
  )
}

getOrCreateRendererRoot(rootElement, import.meta.hot?.data).render(
  <StrictMode>
    <I18nProvider>
      <PopoutSettingsSync />
      <PopoutRoot />
    </I18nProvider>
  </StrictMode>
)
recordRendererCrashBreadcrumb('popout_bootstrap_rendered')
