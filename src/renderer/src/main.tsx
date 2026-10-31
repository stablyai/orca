// Install the import-free hook before react-dom reads it during evaluation; the observer below wraps a per-commit property and can load later.
import './lib/react-devtools-commit-hook-shim'
import './lib/react-commit-cascade-observer'
import './assets/main.css'

import { StrictMode } from 'react'
import { useTranslation } from 'react-i18next'
import App from './App'
import { RecoverableRenderErrorBoundary } from './components/error-boundaries/RecoverableRenderErrorBoundary'
import {
  installRendererCrashDiagnostics,
  recordRendererCrashBreadcrumb
} from './lib/crash-diagnostics'
import { installAutomationHostDiagnostic } from './components/automations/automation-host-diagnostics'
import {
  applyCachedPluginAppTheme,
  applyDocumentTheme,
  readCachedPluginAppTheme
} from './lib/document-theme'
import { installTypingLatencyDiagnostic } from './lib/typing-latency/diagnostic'
import { installAppKeyboardRouter } from './lib/app-keyboard-router'
import { shouldEnableReactGrab } from './lib/react-grab-dev-gate'
import { I18nProvider } from './i18n/I18nProvider'
import { translate } from './i18n/i18n'
import { getOrCreateRendererRoot } from './lib/react-renderer-root'
import { primeTerminalWebglAddon } from './lib/pane-manager/pane-webgl-renderer'
import { SkillWarningPreviewLauncher } from './components/skills/SkillWarningPreviewLauncher'
import { installBrowserClientPageRenderer } from './components/browser-pane/browser-client-page-renderer-installation'
import { registerBrowserClientPageGuestMessageHandler } from './components/browser-pane/browser-client-page-retained-elements'
import { handleGuestWindowCloseMessage } from './components/browser-pane/host-guest/browser-page-window-close'
import { installOsFileDropCancellationGuard } from './lib/os-file-drop-cancellation-guard'
import { installBodyOverlayAttributes } from './lib/body-overlay-attributes'

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
  useTranslation()
  return (
    <RecoverableRenderErrorBoundary
      boundaryId="app.root"
      surface="app-root"
      title={translate('app.recoverableError.rootTitle', 'Orca hit a renderer error.')}
      description={translate(
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
