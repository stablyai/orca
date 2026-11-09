import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Circle, CircleCheck } from 'lucide-react'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { startVmBuildAgentSignIn } from '@/lib/agent-sign-in/vm-build-agent-sign-in'
import {
  readHostAgentSignInReport,
  subscribeHostAgentSignInReports
} from '@/runtime/provider-accounts/sign-in/host-agent-sign-in-status-client'
import { HOST_AGENT_SIGN_IN_AGENTS } from '../../../../shared/host-agent-sign-in-status'
import { ORCA_CLOUD_RECIPE_ID } from '../../../../shared/hosted-sandbox/orca-cloud-recipe-id'
import type { PendingWorktreeCreation } from '@/lib/workspace/creation/pending-worktree-creation'
import { cloudSecretRepoKey } from '../settings/cloud-secrets/cloud-secret-repos'
import { isCloudAgentReady, type CloudAgentReadiness } from './cloud-agent-readiness'
import {
  CloudAgentSetupView,
  cloudAgentReadinessSummary,
  type CloudAgentSetupViewProps
} from './CloudAgentSetupView'
import { useCloudAgentSetup } from './use-cloud-agent-setup'

export type VmBuildCloudAgentStepModel =
  | { kind: 'ready'; readiness: CloudAgentReadiness }
  | { kind: 'setup'; readiness: CloudAgentReadiness; canShare: boolean }

/** A checklist row: a one-line "agents ready" confirmation, or "Add an agent" with its options below. */
export function VmBuildCloudAgentStepView({
  model,
  setup
}: {
  model: VmBuildCloudAgentStepModel
  setup: Omit<CloudAgentSetupViewProps, 'readiness' | 'canShare' | 'surface'>
}): React.JSX.Element {
  const t = useTranslate()
  if (model.kind === 'ready') {
    const detail = cloudAgentReadinessSummary(model.readiness, t)
    return (
      <li className="flex items-center gap-2.5 py-1.5" data-vm-build-cloud-agent="ready">
        <CircleCheck aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{t('cloudAgentSetup.readyTitle', 'Agents ready')}</span>
          <span className="truncate text-xs text-muted-foreground">{detail}</span>
        </div>
      </li>
    )
  }
  return (
    <li className="flex flex-col gap-2 py-1.5" data-vm-build-cloud-agent="setup">
      <div className="flex items-center gap-2.5">
        <Circle aria-hidden className="size-3.5 shrink-0 text-muted-foreground/60" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">
            {t('cloudAgentSetup.title', 'Add an agent')}
            <span className="text-xs text-muted-foreground">
              {' · '}
              {t('vmBuildAgentSignIn.optional', 'optional')}
            </span>
          </span>
          <span className="text-xs text-muted-foreground">
            {t(
              'cloudAgentSetup.subtitleBuild',
              'Choose how Claude Code or Codex gets access in Orca Cloud, while the VM builds.'
            )}
          </span>
        </div>
      </div>
      <div className="pl-6 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1 motion-safe:duration-200">
        <CloudAgentSetupView
          {...setup}
          readiness={model.readiness}
          canShare={model.canShare}
          surface="build"
        />
      </div>
    </li>
  )
}

/**
 * "Add an agent" before the first Orca Cloud workspace. Runs beside provisioning, never in front of it,
 * and only once: when agents are already covered it is a one-line confirmation instead.
 */
export function VmBuildCloudAgentStep({
  creationId,
  entry
}: {
  creationId: string
  entry: PendingWorktreeCreation
}): React.JSX.Element | null {
  const done = useAppStore((s) => s.cloudAgentSetupDone)
  const markDone = useAppStore((s) => s.markCloudAgentSetupDone)
  // Decided once per build, so finishing the step mid-build does not yank its confirmation away.
  const [eligible] = useState(() => !done)
  const [closed, setClosed] = useState(false)
  const [signInRequested, setSignInRequested] = useState(false)
  const signInStarted = useRef(false)
  const isCloud = entry.request.ephemeralVmRecipe?.recipeId === ORCA_CLOUD_RECIPE_ID
  const repoKey = useAppStore((s) => {
    const repo = s.repos.find((candidate) => candidate.id === entry.request.repoId)
    return repo ? cloudSecretRepoKey(repo) : null
  })
  const environmentId = entry.vmEnvironmentId ?? null
  const { model, save } = useCloudAgentSetup({
    repo: repoKey,
    runtimeEnvironmentId: environmentId,
    enabled: isCloud && eligible
  })
  const report = useSyncExternalStore(subscribeHostAgentSignInReports, () =>
    environmentId ? readHostAgentSignInReport(environmentId) : null
  )
  const hostLabel = useAppStore(
    (s) => s.runtimeEnvironments.find((environment) => environment.id === environmentId)?.name
  )
  const alreadyReady = model.status === 'ready' && isCloudAgentReady(model.readiness)

  useEffect(() => {
    if (alreadyReady) {
      markDone()
    }
  }, [alreadyReady, markDone])

  // "Sign in when ready": start the in-VM sign-in as soon as the VM says which agents need it.
  useEffect(() => {
    if (!signInRequested || signInStarted.current || !environmentId || !report) {
      return
    }
    signInStarted.current = true
    const signedOut = HOST_AGENT_SIGN_IN_AGENTS.filter(
      (agent) => report.agents.find((entry) => entry.agent === agent)?.state === 'signedOut'
    )
    if (signedOut.length > 0) {
      void startVmBuildAgentSignIn(creationId, environmentId, hostLabel ?? environmentId, signedOut)
    }
  }, [signInRequested, environmentId, report, creationId, hostLabel])

  if (!isCloud || !eligible || closed || model.status === 'loading' || entry.status === 'error') {
    return null
  }
  const finish = (): void => {
    markDone()
    setClosed(true)
  }
  return (
    <VmBuildCloudAgentStepView
      model={
        alreadyReady
          ? { kind: 'ready', readiness: model.readiness }
          : { kind: 'setup', readiness: model.readiness, canShare: model.canShare }
      }
      setup={{
        onSave: async (choice, scope) => {
          const failure = await save(choice, scope)
          if (!failure) {
            markDone()
          }
          return failure
        },
        onSignIn: () => {
          setSignInRequested(true)
          finish()
        },
        onLater: finish
      }}
    />
  )
}
