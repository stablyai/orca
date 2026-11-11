// Mounts the Orca Cloud setup page over the workspace area while a Start is waiting on setup. Other
// pages (Settings for billing or agent accounts) show over it; coming back shows it again. Opening
// another workspace from the sidebar puts setup away (Back in the composer still has the prompt).
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { clearCloudStartDraft } from '@/lib/orca-cloud/cloud-start-draft'
import { cancelCloudCreateIntent } from '@/lib/orca-cloud/cloud-create-intent'
import {
  closeCloudSetupPage,
  useCloudSetupPageRequest,
  type CloudSetupPageRequest
} from '@/lib/orca-cloud/cloud-setup-page-store'
import { CLOUD_SETUP_ALL_SET_HOLD_MS } from '@/lib/orca-cloud/cloud-setup-session-seam'
import { isOrcaCloudAccountAgent } from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import { ORCA_CLOUD_RECIPE_ID } from '../../../../shared/hosted-sandbox/orca-cloud-recipe-id'
import { agentName } from '@/components/settings/agent-accounts/orca-cloud-accounts-copy'
import { prefersReducedMotion } from '@/components/new-workspace/run-on/cloud-start-view'
import { CloudSetupPage } from './CloudSetupPage'
import { closeSetupPageWhenCreateTakesOver } from './cloud-setup-handoff'
import { useCloudSetupFlow } from './use-cloud-setup-flow'

/** How long every row must read done before the page starts the workspace. */
const SETTLE_MS = 1_500

/**
 * The × leaves setup. Nothing starts later (JA-01): the page and its auto-start go away, and the
 * on-disk draft is dropped. The draft stays one click away in a toast, as a filled composer.
 */
function exitSetup(request: CloudSetupPageRequest): void {
  cancelCloudCreateIntent(request.intentId)
  closeCloudSetupPage()
  clearCloudStartDraft(useAppStore.getState().activeOrcaProfileId ?? null)
  toast.message(
    translate('cloudSetupPage.exited', 'Orca Cloud setup closed. Your draft is kept.'),
    {
      action: {
        label: translate('cloudSetupPage.resumeDraft', 'Open draft'),
        onClick: () => reopenComposer(request, false)
      }
    }
  )
}

function reopenComposer(request: CloudSetupPageRequest, autoStart: boolean): void {
  // A GitHub-only repository can't be preselected; the composer opens for one more Start.
  const hiddenStart = autoStart && !request.cloudOnlyRepo
  if (!hiddenStart) {
    // Back, or a start that needs one more press: this setup's intent can never create.
    cancelCloudCreateIntent(request.intentId)
    closeCloudSetupPage()
    clearCloudStartDraft(useAppStore.getState().activeOrcaProfileId ?? null)
  } else {
    // Warm the start screen's chunk so it is ready the frame the create takes over.
    void import('@/components/worktree-creation/WorktreeCreationPanel').catch(() => undefined)
  }
  useAppStore.getState().openModal('new-workspace-composer', {
    ...request.composer,
    initialEphemeralVmRecipeId: ORCA_CLOUD_RECIPE_ID,
    ...(hiddenStart ? { cloudAutoStart: true, cloudCreateIntent: request.intentId } : {})
  })
  if (hiddenStart) {
    // The page stays up until the start screen has painted: nothing under it may flash.
    closeSetupPageWhenCreateTakesOver({
      getState: () => useAppStore.getState(),
      subscribe: (listener) => useAppStore.subscribe(listener),
      startScreenShown: () => document.querySelector('[data-vm-build-sheet]') !== null,
      closePage: closeCloudSetupPage,
      setTimer: (callback, ms) => window.setTimeout(callback, ms),
      clearTimer: (handle) => window.clearTimeout(handle)
    })
  }
}

function ActiveCloudSetupPage({ request }: { request: CloudSetupPageRequest }): React.JSX.Element {
  const t = useTranslate()
  const flow = useCloudSetupFlow(request, request.debugAccess)
  const projectName = useAppStore(
    (s) => s.repos.find((repo) => repo.id === request.repoId)?.displayName ?? null
  )
  const agentLabel = isOrcaCloudAccountAgent(request.agent) ? agentName(request.agent, t) : null
  const [starting, setStarting] = useState(false)
  // Rows can all read done for a moment right after a sign-in, before billing, GitHub and agent
  // accounts answer for the new account. Done must hold for SETTLE_MS before "All set".
  const done = flow.action === 'done'
  useEffect(() => {
    if (!done) {
      return
    }
    const timer = window.setTimeout(() => setStarting(true), SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [done])
  useEffect(() => {
    if (!starting) {
      return
    }
    const timer = window.setTimeout(
      () => reopenComposer(request, true),
      prefersReducedMotion() ? 0 : CLOUD_SETUP_ALL_SET_HOLD_MS
    )
    return () => window.clearTimeout(timer)
  }, [request, starting])
  const onBackToComposer = useCallback(() => reopenComposer(request, false), [request])
  const onExit = useCallback(() => exitSetup(request), [request])
  return (
    <CloudSetupPage
      flow={flow}
      projectName={projectName}
      prompt={request.prompt}
      agentLabel={agentLabel}
      onBackToComposer={onBackToComposer}
      onExit={onExit}
      starting={starting}
    />
  )
}

export function CloudSetupPageLayer(): React.JSX.Element | null {
  const request = useCloudSetupPageRequest()
  const onWorkspaceView = useAppStore((s) => s.activeView === 'terminal')
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId ?? null)
  const openedOnRef = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    if (!request) {
      openedOnRef.current = undefined
      return
    }
    if (openedOnRef.current === undefined) {
      openedOnRef.current = activeWorktreeId
      return
    }
    if (openedOnRef.current !== activeWorktreeId) {
      cancelCloudCreateIntent(request.intentId)
      closeCloudSetupPage()
    }
  }, [activeWorktreeId, request])
  // The right sidebar (files, source control) is noise during setup: hide it while the page shows,
  // and put it back as it was when the page closes or another page takes over.
  const showing = request !== null && onWorkspaceView
  useEffect(() => {
    if (!showing) {
      return
    }
    const store = useAppStore.getState()
    const wasOpen = store.rightSidebarOpen
    if (wasOpen) {
      store.setRightSidebarOpen(false)
    }
    return () => {
      if (wasOpen && !useAppStore.getState().rightSidebarOpen) {
        useAppStore.getState().setRightSidebarOpen(true)
      }
    }
  }, [showing])
  if (!request) {
    return null
  }
  // Stays mounted under other pages so an open browser trip keeps its session and waiting state.
  return (
    <div
      className={onWorkspaceView ? 'absolute inset-0 z-20 flex bg-background' : 'hidden'}
      aria-hidden={!onWorkspaceView}
    >
      <ActiveCloudSetupPage key={request.openedAt} request={request} />
    </div>
  )
}
