// Mounts the Orca Cloud setup page over the workspace area while a Start is waiting on setup. Other
// pages (Settings for billing or agent accounts) show over it; coming back shows it again. Opening
// another workspace from the sidebar puts setup away (Back in the composer still has the prompt).
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
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
import { useCloudSetupFlow } from './use-cloud-setup-flow'

function reopenComposer(request: CloudSetupPageRequest, autoStart: boolean): void {
  closeCloudSetupPage()
  useAppStore.getState().openModal('new-workspace-composer', {
    ...request.composer,
    initialEphemeralVmRecipeId: ORCA_CLOUD_RECIPE_ID,
    // A GitHub-only repository can't be preselected; the composer opens for one more Start.
    ...(autoStart && !request.cloudOnlyRepo ? { cloudAutoStart: true } : {})
  })
}

function ActiveCloudSetupPage({ request }: { request: CloudSetupPageRequest }): React.JSX.Element {
  const t = useTranslate()
  const flow = useCloudSetupFlow(request)
  const projectName = useAppStore(
    (s) => s.repos.find((repo) => repo.id === request.repoId)?.displayName ?? null
  )
  const agentLabel = isOrcaCloudAccountAgent(request.agent) ? agentName(request.agent, t) : null
  const [starting, setStarting] = useState(false)
  const startedRef = useRef(false)
  useEffect(() => {
    if (flow.action !== 'done' || startedRef.current) {
      return
    }
    startedRef.current = true
    setStarting(true)
    const timer = window.setTimeout(
      () => reopenComposer(request, true),
      prefersReducedMotion() ? 0 : CLOUD_SETUP_ALL_SET_HOLD_MS
    )
    return () => window.clearTimeout(timer)
  }, [flow.action, request])
  const onBack = useCallback(() => reopenComposer(request, false), [request])
  return (
    <CloudSetupPage
      flow={flow}
      projectName={projectName}
      prompt={request.prompt}
      agentLabel={agentLabel}
      onBack={onBack}
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
      closeCloudSetupPage()
    }
  }, [activeWorktreeId, request])
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
