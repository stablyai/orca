// Why first, and why the import-free shim: react-dom reads
// __REACT_DEVTOOLS_GLOBAL_HOOK__ once at module evaluation, so the global has to
// exist before it. The observer below only wraps a property react-dom re-reads
// per commit, so its own import graph can evaluate whenever it likes.
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
import { applyDocumentTheme } from './lib/document-theme'
import { installTypingLatencyDiagnostic } from './lib/typing-latency/diagnostic'
import { shouldEnableReactGrab } from './lib/react-grab-dev-gate'
import { I18nProvider } from './i18n/I18nProvider'
import { translate } from './i18n/i18n'
import { getOrCreateRendererRoot } from './lib/react-renderer-root'
import { primeTerminalWebglAddon } from './lib/pane-manager/pane-webgl-renderer'
import { SkillWarningPreviewLauncher } from './components/skills/SkillWarningPreviewLauncher'
import { installBrowserClientPageRenderer } from './components/browser-pane/browser-client-page-renderer-installation'
import { installOsFileDropCancellationGuard } from './lib/os-file-drop-cancellation-guard'
import { installSidebarShadowComparison } from './lib/sidebar-shadow/sidebar-shadow-comparison'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../shared/sidebar-inputs-switch'
import { workspaceActivityShadow } from './lib/sidebar-shadow/workspace-activity-shadow'
import {
  pairedServerHostsShadow,
  pairedServerRowsShadow
} from './lib/sidebar-shadow/paired-server-rows-shadow'
import { desktopFactsShadow } from './lib/sidebar-shadow/desktop-facts-shadow'
import { workspaceReviewShadow } from './lib/sidebar-shadow/workspace-review-shadow'
import { sidebarTemporalShadow } from './lib/sidebar-shadow/sidebar-temporal-shadow'
import { workspaceCreationsShadow } from './lib/sidebar-shadow/workspace-creations-shadow'
import { workspaceRowsShadow } from './lib/sidebar-shadow/workspace-rows-shadow'

const disposeOsFileDropGuard = installOsFileDropCancellationGuard()
import.meta.hot?.dispose(disposeOsFileDropGuard)
recordRendererCrashBreadcrumb('renderer_bootstrap_started', { dev: import.meta.env.DEV })
installRendererCrashDiagnostics()
installTypingLatencyDiagnostic()
installAutomationHostDiagnostic()
// Switch point: only a build where main produces the sidebar's inputs compares them.
if (ORCA_SIDEBAR_INPUTS_IS_MAIN) {
  const disposeSidebarShadow = installSidebarShadowComparison([
    workspaceActivityShadow,
    pairedServerRowsShadow,
    pairedServerHostsShadow,
    desktopFactsShadow,
    workspaceReviewShadow,
    sidebarTemporalShadow,
    workspaceCreationsShadow,
    workspaceRowsShadow
  ])
  import.meta.hot?.dispose(disposeSidebarShadow)
}

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

applyDocumentTheme('system', { disableTransitions: false })
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

// Why here: the xterm WebGL addon is 243 KB, is only ever constructed once a
// terminal attaches (many frames away), and is needed by nothing during boot.
// Starting the load after the first render keeps it off the boot graph while
// leaving it resolved long before any pane can attach.
void primeTerminalWebglAddon()
