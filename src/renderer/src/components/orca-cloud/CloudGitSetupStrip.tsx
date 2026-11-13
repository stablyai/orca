// GIT-SETUP: one strip above the workspace's panes (never one per split pane) while the sandbox
// reports that its teammates' git identities couldn't be installed. Same shape as the cloud sign-in
// strip; its action is the workspace Restart, whose boot installs them again.
import React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useCloudWorkspace } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { isCloudStatusRow } from '@/lib/orca-cloud/orca-cloud-workspace-rows'
import { dismissCloudGitSetup, useCloudGitSetup } from '@/lib/orca-cloud/cloud-git-setup-store'
import {
  CloudAgentSignInStrip,
  type CloudStripActions
} from '../agent-sign-in-strip/CloudAgentSignInStrip'
import { useConfirmedRestart } from './use-cloud-panel-actions'
import {
  cloudGitSetupStripModel,
  cloudGitSetupStripPhase,
  type CloudGitSetupStripPhase
} from './cloud-git-setup-strip-model'

export function CloudGitSetupStripView({
  phase,
  onRestart,
  onDismiss
}: {
  phase: CloudGitSetupStripPhase
  onRestart: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const actions: CloudStripActions = {
    primary: (action) => (action.kind === 'restart' && phase !== 'restarting' ? onRestart() : null),
    submitCode: () => undefined,
    pasteCode: () => undefined,
    useCode: () => undefined,
    useApiKey: () => undefined,
    cancel: () => (phase === 'restarting' ? undefined : onDismiss())
  }
  return (
    <div data-cloud-git-setup-strip={phase} className="shrink-0">
      <CloudAgentSignInStrip
        model={cloudGitSetupStripModel(phase, t)}
        prompt={null}
        actions={actions}
      />
    </div>
  )
}

/** Renders nothing unless this Orca Cloud workspace reports a failed git setup. */
export function CloudGitSetupStrip({
  worktreeId
}: {
  worktreeId: string | null
}): React.JSX.Element | null {
  const id = worktreeId ?? ''
  // PAIRED-GIT-SETUP: a paired row's status reads like an owned one's, and its Restart reaches the
  // sandbox (PAIRED-WAKE), so its strip shows the same way.
  const isCloud = useCloudWorkspace((s) => (worktreeId ? isCloudStatusRow(s, worktreeId) : false))
  const gitSetupFailed = useCloudWorkspace((s) => s.status[id]?.status?.gitSetupFailed === true)
  const dismissed = useCloudGitSetup((s) => s.dismissed[id] === true)
  const restarted = useCloudGitSetup((s) => s.restarted[id] === true)
  const restarting = useCloudWorkspace((s) => s.pending[id] === 'restart')
  if (!worktreeId || !isCloud) {
    return null
  }
  const phase = cloudGitSetupStripPhase({ gitSetupFailed, dismissed, restarting, restarted })
  // Mounted in every tab group: only a shown strip reads the workspace's activity (for Restart).
  return phase ? <ShownCloudGitSetupStrip worktreeId={worktreeId} phase={phase} /> : null
}

function ShownCloudGitSetupStrip({
  worktreeId,
  phase
}: {
  worktreeId: string
  phase: CloudGitSetupStripPhase
}): React.JSX.Element {
  const restart = useConfirmedRestart(worktreeId)
  return (
    <CloudGitSetupStripView
      phase={phase}
      onRestart={restart}
      onDismiss={() => dismissCloudGitSetup(worktreeId)}
    />
  )
}
