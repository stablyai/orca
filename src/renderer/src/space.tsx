import './assets/main.css'
import { StrictMode, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmationDialogProvider } from './components/confirmation-dialog'
import DeleteWorktreeDialog from './components/sidebar/DeleteWorktreeDialog'
import PreservedBranchBatchReviewModal from './components/sidebar/PreservedBranchBatchReviewModal'
import WorkspaceSpacePage from './components/workspace-space/WorkspaceSpacePage'
import {
  isSpaceWindowState,
  selectSpaceWindowAnalysis
} from './components/workspace-space/space-window-state'
import { RecoverableRenderErrorBoundary } from './components/error-boundaries/RecoverableRenderErrorBoundary'
import { applyDocumentTheme } from './lib/document-theme'
import { buildAppFontFamily } from './lib/app-font-family'
import { getOrCreateRendererRoot } from './lib/react-renderer-root'
import { I18nProvider } from './i18n/I18nProvider'
import { useAppStore } from './store'

function SpaceWindowRoot(): React.JSX.Element {
  const { t } = useTranslation()
  const settings = useAppStore((state) => state.settings)
  const activeModal = useAppStore((state) => state.activeModal)

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

  useEffect(() => {
    applyDocumentTheme(settings?.theme ?? 'system', { disableTransitions: false })
    document.documentElement.style.setProperty(
      '--app-font-family',
      buildAppFontFamily(settings?.appFontFamily)
    )
    if (settings?.theme !== 'system') {
      return
    }
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = (): void => applyDocumentTheme('system')
    media.addEventListener('change', handleChange)
    return () => media.removeEventListener('change', handleChange)
  }, [settings?.theme, settings?.appFontFamily])

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
      <TooltipProvider delayDuration={400}>
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
