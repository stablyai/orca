// Install the import-free hook before react-dom reads it during evaluation; the observer below wraps a per-commit property and can load later.
import './diagnostics/react-commits/react-devtools-commit-hook-shim'
import './diagnostics/react-commits/react-commit-cascade-observer'
import './assets/main.css'

import { StrictMode } from 'react'
import { useTranslation } from 'react-i18next'
import App from './App'
import { RecoverableRenderErrorBoundary } from './components/error-boundaries/RecoverableRenderErrorBoundary'
import { installRendererCrashDiagnostics } from './diagnostics/crash-reporting/crash-diagnostics'
import { recordRendererCrashBreadcrumb } from './diagnostics/crash-reporting/crash-breadcrumb-recorder'
import { installAutomationHostDiagnostic } from './components/automations/hosts/automation-host-diagnostics'
import {
  applyCachedPluginAppTheme,
  applyDocumentTheme,
  readCachedPluginAppTheme
} from './app-shell/appearance/document-theme'
import { installTypingLatencyDiagnostic } from './diagnostics/typing-latency/diagnostic'
import { installAppKeyboardRouter } from './lib/keyboard/app-keyboard-router'
import { shouldEnableReactGrab } from './diagnostics/react-commits/react-grab-dev-gate'
import { I18nProvider } from './i18n/I18nProvider'
import { useTranslate } from './i18n/use-translate'
import { getOrCreateRendererRoot } from './app-shell/startup/react-renderer-root'
import { primeTerminalWebglAddon } from './lib/pane-manager/pane-webgl-renderer'
import { SkillWarningPreviewLauncher } from './components/skills/installation/preview/SkillWarningPreviewLauncher'
import { installBrowserClientPageRenderer } from './components/browser-pane/browser-client-page-renderer-installation'
import { registerBrowserClientPageGuestMessageHandler } from './components/browser-pane/browser-client-page-retained-elements'
import { handleGuestWindowCloseMessage } from './components/browser-pane/host-guest/browser-page-window-close'
import { installOsFileDropCancellationGuard } from './lib/files/drop/os-file-drop-cancellation-guard'
import { installBodyOverlayAttributes } from './lib/body-overlay-attributes'
import { applyWindowMaterialToDocument } from './app-shell/appearance/window-material-runtime'

const disposeOsFileDropGuard = installOsFileDropCancellationGuard()
import.meta.hot?.dispose(disposeOsFileDropGuard)
const disposeBodyOverlayAttributes = installBodyOverlayAttributes()
import.meta.hot?.dispose(disposeBodyOverlayAttributes)
recordRendererCrashBreadcrumb('renderer_bootstrap_started', { dev: import.meta.env.DEV })
installRendererCrashDiagnostics()
installTypingLatencyDiagnostic()
installAppKeyboardRouter()
installAutomationHostDiagnostic()

if (
  import.meta.env.DEV &&
  shouldEnableReactGrab({
    dev: import.meta.env.DEV,
    enableFlag: import.meta.env.VITE_ENABLE_REACT_GRAB
  })
) {
  void import('react-grab').then(({ init }) => init())
  void import('react-grab/styles.css')
}

applyWindowMaterialToDocument()
const cachedPluginTheme = readCachedPluginAppTheme()
applyDocumentTheme(cachedPluginTheme?.base ?? 'system', { disableTransitions: false })
if (cachedPluginTheme) {
  applyCachedPluginAppTheme(cachedPluginTheme)
}
registerBrowserClientPageGuestMessageHandler(handleGuestWindowCloseMessage)
const browserClientPageRenderer = installBrowserClientPageRenderer()
import.meta.hot?.dispose(() => browserClientPageRenderer?.dispose())

const rootElement = document.getElementById('root')
if (!rootElement) {
  recordRendererCrashBreadcrumb('renderer_root_missing')
  throw new Error('Renderer root element not found.')
}

function RendererRoot(): React.JSX.Element {
  const t = useTranslate()
  useTranslation()
  return (
    <RecoverableRenderErrorBoundary
      boundaryId="app.root"
      surface="app-root"
      title={t('app.recoverableError.rootTitle', 'Orca hit a renderer error.')}
      description={t(
        'app.recoverableError.rootDescription',
        'The app shell could not finish rendering. Retry to remount it, or relaunch Orca if the error persists.'
      )}
    >
      <App />
      <SkillWarningPreviewLauncher />
    </RecoverableRenderErrorBoundary>
  )
}

getOrCreateRendererRoot(rootElement, import.meta.hot?.data).render(
  <StrictMode>
    <I18nProvider>
      <RendererRoot />
    </I18nProvider>
  </StrictMode>
)
recordRendererCrashBreadcrumb('renderer_bootstrap_rendered')

// Defer the 243KB WebGL addon until first render; panes need it only much later, keeping it off boot’s import graph.
void primeTerminalWebglAddon()
