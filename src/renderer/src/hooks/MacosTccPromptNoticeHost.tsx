import React, { Suspense } from 'react'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { useMacFolderAccessFixStore } from '@/store/terminals/folder-access/mac-folder-access-fix'
import { useMacosTccPromptNotice } from '../components/macos-permissions/useMacosTccPromptNotice'
import { useMacTccAttributionSeveredNotice } from '../components/macos-permissions/useMacTccAttributionSeveredNotice'

const MacFolderAccessFixDialog = lazy(() =>
  import('@/components/shared/MacFolderAccessFixDialog').then((module) => ({
    default: module.MacFolderAccessFixDialog
  }))
)

export function MacosTccPromptNoticeHost(): React.JSX.Element | null {
  useMacosTccPromptNotice()
  // Why: severed daemon attribution only showed in Settings (#13594); toast the remedy at launch/focus.
  useMacTccAttributionSeveredNotice()
  const hasOpenFix = useMacFolderAccessFixStore((state) => state.openScope !== null)
  // Why here: the folder-access toast raises this dialog, and both must outlive any one screen.
  return hasOpenFix ? (
    <Suspense fallback={null}>
      <MacFolderAccessFixDialog />
    </Suspense>
  ) : null
}
