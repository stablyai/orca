import React from 'react'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import { useAppStore } from '@/store/index'

const WorktreeMetaDialog = lazyWithRetry(
  () => import('./workspace-card/metadata/WorktreeMetaDialog')
)
const RemoveFolderDialog = lazyWithRetry(
  () => import('./workspace-actions/deletion/RemoveFolderDialog')
)
const SleepTwinWorkspaceDialog = lazyWithRetry(
  () => import('./workspace-actions/sleep/SleepTwinWorkspaceDialog')
)
const WorktreeVisibilityDialog = lazyWithRetry(
  () => import('./workspace-visibility/dialog/WorktreeVisibilityDialog')
)
const OrcaYamlTrustDialog = lazyWithRetry(
  () => import('./workspace-creation/hook-trust/OrcaYamlTrustDialog')
)
const OpenOnHostDialog = lazyWithRetry(() => import('../open-on-host/OpenOnHostDialog'))
const ForgetSshWorkspaceDialog = lazyWithRetry(
  () => import('./workspace-actions/deletion/ForgetSshWorkspaceDialog')
)
// Mount each flow only while its modal is active.
export function SidebarModalDialogs(): React.JSX.Element {
  const activeModal = useAppStore((s) => s.activeModal)
  return (
    <React.Suspense fallback={null}>
      {activeModal === 'edit-meta' ? <WorktreeMetaDialog /> : null}
      {activeModal === 'confirm-remove-folder' ? <RemoveFolderDialog /> : null}
      {activeModal === 'confirm-sleep-twin' ? <SleepTwinWorkspaceDialog /> : null}
      {activeModal === 'worktree-visibility' ? <WorktreeVisibilityDialog /> : null}
      {activeModal === 'confirm-orca-yaml-hooks' ? <OrcaYamlTrustDialog /> : null}
      {activeModal === 'forget-ssh-workspace' ? <ForgetSshWorkspaceDialog /> : null}
      {activeModal === 'open-on-host' ? <OpenOnHostDialog /> : null}
    </React.Suspense>
  )
}
