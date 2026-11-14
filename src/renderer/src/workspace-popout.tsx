import './diagnostics/react-commits/react-devtools-commit-hook-shim'
import './diagnostics/react-commits/react-commit-cascade-observer'
import './assets/main.css'

import { StrictMode, useEffect, useState } from 'react'
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
import { AgentTerminalPreview } from './components/dashboard-popout/AgentTerminalPreview'
import type { WorkspacePopoutTarget } from '../../shared/workspace-popout/workspace-popout-contract'
import { Button } from './components/ui/button'
import { ArrowDownLeft, TerminalIcon } from 'lucide-react'

const disposeOsFileDropGuard = installOsFileDropCancellationGuard()
import.meta.hot?.dispose(disposeOsFileDropGuard)
const disposeBodyOverlayAttributes = installBodyOverlayAttributes()
import.meta.hot?.dispose(disposeBodyOverlayAttributes)

recordRendererCrashBreadcrumb('workspace_popout_bootstrap_started', { dev: import.meta.env.DEV })
installRendererCrashDiagnostics('workspace-popout')
setReactCommitCascadeRendererSurface('workspace-popout')

function applyPopoutAppearance(settings: GlobalSettings | null): void {
  applyDocumentTheme(resolvePaintedTheme(settings), { disableTransitions: false })
  document.documentElement.style.setProperty(
    '--app-font-family',
    buildAppFontFamily(settings?.appFontFamily)
  )
  applyCodeFontSmoothing(settings?.codeFontSmoothing)
}

let startupSettings: GlobalSettings | null = null
try {
  startupSettings = window.api?.settings ? window.api.settings.getSync() : null
} catch {
  // Async hydration remains available.
}
if (startupSettings) {
  useAppStore.setState({ settings: startupSettings })
}
applyPopoutAppearance(startupSettings)

const rootElement = document.getElementById('root')
if (!rootElement) {
  recordRendererCrashBreadcrumb('workspace_popout_root_missing')
  throw new Error('Workspace pop-out root element not found.')
}

function WorkspacePopoutSettingsSync(): null {
  const settings = useAppStore((state) => state.settings)
  useReduceVisualEffects(settings?.reduceVisualEffects)

  useEffect(() => {
    let disposed = false
    void useAppStore.getState().fetchKeybindings?.()
    const setSettings = (next: GlobalSettings): void => {
      if (!disposed) {
        useAppStore.setState({ settings: next })
      }
    }
    const offChanged = window.api?.settings?.onChanged((updates) => {
      const current = useAppStore.getState().settings
      if (current) {
        setSettings({ ...current, ...updates })
      }
    })
    void window.api?.settings
      ?.get()
      .then(setSettings)
      .catch(() => undefined)
    return () => {
      disposed = true
      offChanged?.()
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

function WorkspacePopoutContent(): React.JSX.Element {
  const t = useTranslate()
  const [target, setTarget] = useState<WorkspacePopoutTarget | null>(null)
  const [epoch, setEpoch] = useState(0)

  useEffect(() => {
    let active = true
    if (!window.api?.workspacePopout) {
      return undefined
    }

    void window.api.workspacePopout.getTarget().then((initialTarget) => {
      if (active && initialTarget) {
        setTarget(initialTarget)
      }
    })

    const offTarget = window.api.workspacePopout.onTarget((updatedTarget) => {
      setTarget(updatedTarget)
    })

    const offResumed = window.api.workspacePopout.onResumed(() => {
      setEpoch((prev) => prev + 1)
    })

    return () => {
      active = false
      offTarget?.()
      offResumed?.()
    }
  }, [])

  useEffect(() => {
    if (target?.title) {
      document.title = target.title
    }
  }, [target?.title])

  useEffect(() => {
    const handleFocus = (): void => {
      window.dispatchEvent(new Event('resize'))
    }
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [])

  const handleDock = (): void => {
    if (target?.worktreeId) {
      void window.api?.workspacePopout?.dock(target.worktreeId)
    }
  }

  if (!target) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background text-sm text-muted-foreground">
        <TerminalIcon className="mr-2 size-4 animate-pulse" />
        {t('auto.workspacePopout.connecting', 'Connecting to terminal...')}
      </div>
    )
  }

  return (
    <div className="flex h-screen w-screen flex-col bg-background select-none">
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-border bg-muted/40 px-3 text-xs">
        <div className="flex items-center gap-1.5 font-medium text-foreground truncate">
          <TerminalIcon className="size-3.5 text-muted-foreground shrink-0" />
          <span className="truncate">{target.title || target.ptyId}</span>
        </div>
        <Button
          variant="ghost"
          size="xs"
          onClick={handleDock}
          title={t('auto.workspacePopout.dockTooltip', 'Dock terminal back to main window (Cmd+W)')}
        >
          <ArrowDownLeft className="size-3" />
          {t('auto.workspacePopout.dockButton', 'Dock to window')}
        </Button>
      </div>
      <div className="flex-1 min-h-0 min-w-0">
        <AgentTerminalPreview
          key={`${target.ptyId}:${epoch}`}
          ptyId={target.ptyId}
          terminalInput={target.terminalInput}
          className="h-full w-full"
        />
      </div>
    </div>
  )
}

getOrCreateRendererRoot(rootElement, import.meta.hot?.data).render(
  <StrictMode>
    <I18nProvider>
      <WorkspacePopoutSettingsSync />
      <WorkspacePopoutContent />
    </I18nProvider>
  </StrictMode>
)

recordRendererCrashBreadcrumb('workspace_popout_bootstrap_rendered')
