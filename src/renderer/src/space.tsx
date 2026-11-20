import './assets/main.css'
import { StrictMode, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmationDialogProvider } from './components/dismiss/confirmation/confirmation-dialog'
import DeleteWorktreeDialog from './components/sidebar/workspace-actions/deletion/DeleteWorktreeDialog'
import PreservedBranchBatchReviewModal from './components/sidebar/workspace-actions/deletion/PreservedBranchBatchReviewModal'
import WorkspaceSpacePage from './components/workspace-space/WorkspaceSpacePage'
import {
  isSpaceWindowState,
  selectSpaceWindowAnalysis
} from './components/workspace-space/space-window-state'
import { RecoverableRenderErrorBoundary } from './components/error-boundaries/RecoverableRenderErrorBoundary'
import { applyDocumentTheme } from './app-shell/appearance/document-theme'
import { useAppThemePaint } from './app-shell/appearance/use-app-theme-paint'
import { buildAppFontFamily } from './app-shell/appearance/app-font-family'
import { getOrCreateRendererRoot } from './app-shell/startup/react-renderer-root'
import { I18nProvider } from './i18n/I18nProvider'
import { useAppStore } from './store/index'
import { installBodyOverlayAttributes } from './lib/overlay-interaction/body-overlay-attributes'
import { installLoopingAnimationClock } from './lib/window-activity/looping-animation-clock'
import { useReduceVisualEffects } from './hooks/theme/use-reduce-visual-effects'
import { registerBackgroundWorkerPausedIpcBridge } from './hooks/ipc-events/native-app/background-worker-paused-ipc-bridge'

const disposeBodyOverlayAttributes = installBodyOverlayAttributes()
import.meta.hot?.dispose(disposeBodyOverlayAttributes)
const disposeLoopingAnimationClock = installLoopingAnimationClock()
import.meta.hot?.dispose(disposeLoopingAnimationClock)
// Why before settings arrive: the window otherwise paints without a light or dark mode.
applyDocumentTheme('system', { disableTransitions: false })

function SpaceWindowRoot(): React.JSX.Element {
  const { t } = useTranslation()
  const settings = useAppStore((state) => state.settings)
  const activeModal = useAppStore((state) => state.activeModal)
  useReduceVisualEffects(settings?.reduceVisualEffects)
  useAppThemePaint()

  useEffect(() => {
    const api = window.api.workspaceSpace
    const offState = api.onWindowState?.((value) => {
      if (!isSpaceWindowState(value)) {
        return
      }
      const currentAnalysis = useAppStore.getState().workspaceSpaceAnalysis
      const currentScanning = useAppStore.getState().workspaceSpaceScanning
      const incomingAnalysis = value.workspaceSpaceAnalysis
      useAppStore.setState({
        ...value,
        workspaceSpaceAnalysis: selectSpaceWindowAnalysis(currentAnalysis, incomingAnalysis),
        workspaceSpaceScanning: currentScanning || value.workspaceSpaceScanning,
        workspaceSpaceScanProgress: currentScanning
          ? useAppStore.getState().workspaceSpaceScanProgress
          : value.workspaceSpaceScanProgress
      })
    })
    const offProgress = api.onProgress((progress) => {
      useAppStore.getState().applyWorkspaceSpaceProgress(progress)
    })
    void api.requestWindowState?.()
    void useAppStore.getState().hydrateWorkspaceSpaceFromCache()
    return () => {
      offState?.()
      offProgress()
    }
  }, [])

  // A scan run from this window can pause background work; the notice belongs here too.
  useEffect(() => {
    const unsubs: (() => void)[] = []
    registerBackgroundWorkerPausedIpcBridge(unsubs)
    return () => unsubs.forEach((unsub) => unsub())
  }, [])

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--app-font-family',
      buildAppFontFamily(settings?.appFontFamily)
    )
  }, [settings?.appFontFamily])

  return (
    <RecoverableRenderErrorBoundary
      boundaryId="space-window.root"
      surface="app-root"
      title={t('workspaceSpace.window.errorTitle', 'Space hit an error.')}
      description={t(
        'workspaceSpace.window.errorDescription',
        'Close and reopen Space to try again.'
      )}
    >
      <TooltipProvider>
        <ConfirmationDialogProvider>
          <div className="app-layout">
            <WorkspaceSpacePage />
          </div>
          {activeModal === 'delete-worktree' ? <DeleteWorktreeDialog /> : null}
          {activeModal === 'preserved-branch-review' ? <PreservedBranchBatchReviewModal /> : null}
        </ConfirmationDialogProvider>
        <Toaster closeButton toastOptions={{ className: 'font-sans text-sm' }} />
      </TooltipProvider>
    </RecoverableRenderErrorBoundary>
  )
}

const root = document.getElementById('root')
if (!root) {
  throw new Error('Space window root not found.')
}
getOrCreateRendererRoot(root, import.meta.hot?.data).render(
  <StrictMode>
    <I18nProvider>
      <SpaceWindowRoot />
    </I18nProvider>
  </StrictMode>
)
