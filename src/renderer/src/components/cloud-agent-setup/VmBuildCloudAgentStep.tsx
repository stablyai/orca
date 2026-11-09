import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { CircleCheck, KeyRound } from 'lucide-react'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
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
  cloudAgentSavedSummary,
  type CloudAgentSetupSaved,
  type CloudAgentSetupViewProps
} from './CloudAgentSetupView'
import { useCloudAgentSetup } from './use-cloud-agent-setup'

export type VmBuildCloudAgentStepModel = {
  readiness: CloudAgentReadiness
  canShare: boolean
}

export type VmBuildCloudAgentStepMode =
  | { kind: 'offer' }
  | { kind: 'keys' }
  | { kind: 'signIn' }
  | { kind: 'saved'; saved: CloudAgentSetupSaved }
  | { kind: 'skipped' }

export type VmBuildCloudAgentStepActions = {
  onSave: CloudAgentSetupViewProps['onSave']
  /** The step is done (saved, signing in, or skipped); remember that it ran. */
  onDone: () => void
  onSignIn: () => void
  onCancelSignIn: () => void
  onLater: () => void
}

function Row({
  icon,
  title,
  detail,
  actions
}: {
  icon: React.ReactNode
  title: React.ReactNode
  detail: string
  actions?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2.5">
      {icon}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{title}</span>
        <span className="truncate text-xs text-muted-foreground">{detail}</span>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </div>
  )
}

const OFFER: VmBuildCloudAgentStepMode = { kind: 'offer' }
const KEY_ICON = <KeyRound aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
const DONE_ICON = <CircleCheck aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />

/**
 * One checklist row, never a gate: "Agents ready" when access is already covered, otherwise an
 * optional "Add an agent" with in-VM sign-in first and keys one click away.
 */
export function VmBuildCloudAgentStepView({
  model,
  actions,
  initialMode = OFFER
}: {
  model: VmBuildCloudAgentStepModel
  actions: VmBuildCloudAgentStepActions
  /** Fixtures only. */
  initialMode?: VmBuildCloudAgentStepMode
}): React.JSX.Element {
  const t = useTranslate()
  const [mode, setMode] = useState<VmBuildCloudAgentStepMode>(initialMode)
  const ready = isCloudAgentReady(model.readiness)
  const offerRef = useRef<HTMLButtonElement>(null)
  const signInRef = useRef<HTMLButtonElement>(null)
  const rowRef = useRef<HTMLLIElement>(null)
  // Every swap unmounts the button that had focus; move focus to the new row (or its action) and
  // announce the change, so keyboard and screen-reader users are not dropped on <body>.
  const [announcement, setAnnouncement] = useState('')
  const go = (
    next: VmBuildCloudAgentStepMode,
    focus: 'row' | 'offer' | 'signIn' | 'none',
    say = ''
  ): void => {
    setMode(next)
    setAnnouncement(say)
    requestAnimationFrame(() => {
      const target =
        focus === 'row'
          ? rowRef.current
          : focus === 'offer'
            ? offerRef.current
            : focus === 'signIn'
              ? signInRef.current
              : null
      target?.focus({ preventScroll: true })
    })
  }
  const status = (
    <span role="status" className="sr-only">
      {announcement}
    </span>
  )

  if (mode.kind === 'skipped') {
    return (
      <li
        ref={rowRef}
        tabIndex={-1}
        className="py-1.5 outline-none"
        data-vm-build-cloud-agent="skipped"
      >
        {status}
        <Row
          icon={KEY_ICON}
          title={t('cloudAgentSetup.skippedTitle', 'Agent setup skipped')}
          detail={t(
            'cloudAgentSetup.skippedDetail',
            'Set it up any time from Settings › Orca Account › Cloud secrets.'
          )}
        />
      </li>
    )
  }

  if (mode.kind === 'saved') {
    return (
      <li
        ref={rowRef}
        tabIndex={-1}
        className="py-1.5 outline-none"
        data-vm-build-cloud-agent="saved"
      >
        {status}
        <Row
          icon={DONE_ICON}
          title={cloudAgentSavedSummary(mode.saved, t)}
          detail={t('cloudAgentSetup.saved.short', 'Hidden from now on')}
        />
      </li>
    )
  }

  if (mode.kind === 'signIn') {
    return (
      <li
        ref={rowRef}
        tabIndex={-1}
        className="py-1.5 outline-none"
        data-vm-build-cloud-agent="sign-in"
      >
        {status}
        <Row
          icon={KEY_ICON}
          title={t('cloudAgentSetup.signInPending', 'Agent sign-in')}
          detail={t(
            'cloudAgentSetup.signInPendingDetail',
            'Opens when the sandbox is ready. Keep Orca open until then.'
          )}
          actions={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                actions.onCancelSignIn()
                go(OFFER, 'signIn', t('cloudAgentSetup.signInCancelled', 'Sign-in cancelled'))
              }}
            >
              {t('cloudAgentSetup.skipSignIn', 'Don’t sign in')}
            </Button>
          }
        />
      </li>
    )
  }

  if (ready && mode.kind === 'offer') {
    return (
      <li ref={rowRef} className="py-1.5" data-vm-build-cloud-agent="ready">
        {status}
        <Row
          icon={DONE_ICON}
          title={
            model.readiness.claude && model.readiness.codex
              ? t('cloudAgentSetup.readyTitle', 'Agents ready')
              : t('cloudAgentSetup.readyOne', '{{agent}} ready', {
                  agent: model.readiness.claude ? 'Claude' : 'Codex'
                })
          }
          detail={cloudAgentReadinessSummary(model.readiness, t)}
          actions={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => go({ kind: 'keys' }, 'none')}
            >
              {t('cloudAgentSetup.change', 'Change')}
            </Button>
          }
        />
      </li>
    )
  }

  const title = (
    <>
      {t('cloudAgentSetup.title', 'Add an agent')}
      <span className="text-xs text-muted-foreground">
        {' · '}
        {t('vmBuildAgentSignIn.optional', 'optional')}
      </span>
    </>
  )
  const signIn = (): void => {
    actions.onSignIn()
    actions.onDone()
    go(
      { kind: 'signIn' },
      'row',
      t('cloudAgentSetup.signInQueued', 'Agent sign-in will open when the sandbox is ready')
    )
  }

  return (
    <li ref={rowRef} className="flex flex-col gap-2 py-1.5" data-vm-build-cloud-agent={mode.kind}>
      {status}
      <Row
        icon={KEY_ICON}
        title={title}
        detail={t(
          'cloudAgentSetup.subtitleBuild',
          'Give Claude Code or Codex access in Orca Cloud.'
        )}
        actions={
          mode.kind === 'offer' ? (
            <>
              <Button ref={signInRef} type="button" variant="outline" size="sm" onClick={signIn}>
                {t('cloudAgentSetup.signIn.action', 'Sign in when ready')}
              </Button>
              <Button
                ref={offerRef}
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => go({ kind: 'keys' }, 'none')}
              >
                {t('cloudAgentSetup.useKey', 'Use a key')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  actions.onLater()
                  go(
                    { kind: 'skipped' },
                    'row',
                    t('cloudAgentSetup.skippedTitle', 'Agent setup skipped')
                  )
                }}
              >
                {t('cloudAgentSetup.later', 'Later')}
              </Button>
            </>
          ) : null
        }
      />
      {mode.kind === 'keys' ? (
        <div className="pl-6 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150">
          <CloudAgentSetupView
            readiness={null}
            canShare={model.canShare}
            focusOnOpen
            initialOption="api-key"
            onSave={actions.onSave}
            onSaved={(saved) => {
              actions.onDone()
              go({ kind: 'saved', saved }, 'row', cloudAgentSavedSummary(saved, t))
            }}
            onCancel={() => go(OFFER, 'offer')}
            onSignIn={signIn}
          />
        </div>
      ) : null}
    </li>
  )
}

/** Starts the in-VM sign-in once the VM has reported which agents are signed out. */
function useSignInWhenReady(
  creationId: string,
  environmentId: string | null,
  requested: boolean
): boolean {
  const report = useSyncExternalStore(subscribeHostAgentSignInReports, () =>
    environmentId ? readHostAgentSignInReport(environmentId) : null
  )
  const hostLabel = useAppStore(
    (s) => s.runtimeEnvironments.find((environment) => environment.id === environmentId)?.name
  )
  const started = useRef(false)
  const states = report
    ? HOST_AGENT_SIGN_IN_AGENTS.map(
        (agent) => report.agents.find((entry) => entry.agent === agent)?.state ?? 'unknown'
      )
    : null
  // Not latched while any agent is still being checked, so a later report can start it.
  const settled = states !== null && !states.includes('unknown')

  useEffect(() => {
    if (!requested || started.current || !environmentId || !report || !settled) {
      return
    }
    started.current = true
    const signedOut = HOST_AGENT_SIGN_IN_AGENTS.filter(
      (agent) => report.agents.find((entry) => entry.agent === agent)?.state === 'signedOut'
    )
    if (signedOut.length > 0) {
      void startVmBuildAgentSignIn(creationId, environmentId, hostLabel ?? environmentId, signedOut)
    }
  }, [requested, environmentId, report, settled, creationId, hostLabel])

  // Once the VM has answered, the checklist's own sign-in row takes over.
  return requested && settled
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
  const [signInRequested, setSignInRequested] = useState(false)
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
  const handedToSignInRow = useSignInWhenReady(creationId, environmentId, signInRequested)
  const alreadyReady = model.status === 'ready' && isCloudAgentReady(model.readiness)

  useEffect(() => {
    if (alreadyReady) {
      markDone()
    }
  }, [alreadyReady, markDone])

  if (
    !isCloud ||
    !eligible ||
    handedToSignInRow ||
    model.status === 'loading' ||
    entry.status === 'error'
  ) {
    return null
  }
  return (
    <VmBuildCloudAgentStepView
      model={{ readiness: model.readiness, canShare: model.canShare }}
      actions={{
        onSave: save,
        onDone: markDone,
        onSignIn: () => setSignInRequested(true),
        onCancelSignIn: () => setSignInRequested(false),
        onLater: markDone
      }}
    />
  )
}
