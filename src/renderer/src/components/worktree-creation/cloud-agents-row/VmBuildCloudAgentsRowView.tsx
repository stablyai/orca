// The cloud build sheet's Agents row (spec §5b S1; redesign §5). Its height is decided once, at
// mount: 32 px when every agent was ready then, 48 px otherwise. Every later state renders inside
// that height, so the checklist never moves (AC-3: measured layout shift 0).
import React from 'react'
import { CircleCheck, CircleDashed, Info, KeyRound, Loader2, TriangleAlert, X } from 'lucide-react'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import type {
  BuildAgentsRowDensity,
  BuildAgentsRowModel
} from '@/lib/orca-cloud/orca-cloud-build-agents-row'
import type { OrcaCloudAccountAgent } from '../../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import type { CloudSecretsErrorCode } from '../../../../../shared/cloud-secrets/cloud-secrets-wire'
import { buildAgentsRowText, deviceHost, readyLine } from './build-agents-row-copy'

export type DesktopKeySave =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'failed'; error: CloudSecretsErrorCode }

export type VmBuildCloudAgentsRowActions = {
  setUp: () => void
  cancel: (agent: OrcaCloudAccountAgent) => void
  reopen: (agent: OrcaCloudAccountAgent) => void
  copyCodeAndOpen: (agent: OrcaCloudAccountAgent, code: string) => void
  dismissFailure: (agent: OrcaCloudAccountAgent) => void
  retryLoad: () => void
  manage: () => void
  saveDesktopKey: () => void
  /** §5c only: sign this one workspace in (queued until the sandbox answers). */
  signInHere: (agent: OrcaCloudAccountAgent) => void
  cancelSignInHere: () => void
}

const ICON = 'size-4 shrink-0'
const IDLE_SAVE: DesktopKeySave = { kind: 'idle' }

function StatusIcon({ model }: { model: BuildAgentsRowModel }): React.JSX.Element {
  switch (model.kind) {
    case 'ready':
      return <CircleCheck aria-hidden className={cn(ICON, 'text-muted-foreground')} />
    case 'setup':
    case 'loading':
      return <Loader2 aria-hidden className={cn(ICON, 'animate-spin text-muted-foreground')} />
    case 'failed':
    case 'expired':
    case 'error':
      return <TriangleAlert aria-hidden className={cn(ICON, 'text-status-warning-text')} />
    case 'killSwitch':
      return <Info aria-hidden className={cn(ICON, 'text-muted-foreground')} />
    case 'desktopKey':
      return <KeyRound aria-hidden className={cn(ICON, 'text-muted-foreground')} />
    case 'offer':
    case 'hidden':
      return <CircleDashed aria-hidden className={cn(ICON, 'text-muted-foreground')} />
  }
}

function Trailing({
  model,
  actions,
  desktopKeySave,
  queued,
  t
}: {
  model: BuildAgentsRowModel
  actions: VmBuildCloudAgentsRowActions
  desktopKeySave: DesktopKeySave
  queued: boolean
  t: Translate
}): React.ReactNode {
  const cancel = (agent: OrcaCloudAccountAgent): React.JSX.Element => (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={t('vmBuildAgents.cancel', 'Cancel')}
      onClick={() => actions.cancel(agent)}
    >
      <X aria-hidden />
    </Button>
  )
  switch (model.kind) {
    case 'ready':
      return model.expiring ? (
        <Button type="button" variant="ghost" size="xs" onClick={actions.setUp}>
          {t('vmBuildAgents.renew', 'Renew')}
        </Button>
      ) : null
    case 'offer':
      return (
        <Button type="button" variant="outline" size="xs" onClick={actions.setUp}>
          {t('vmBuildAgents.setUp', 'Set up')}
        </Button>
      )
    case 'setup':
      switch (model.setup.phase) {
        case 'browser':
          return (
            <>
              {model.setup.canReopen ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => actions.reopen(model.agent)}
                >
                  {t('vmBuildAgents.openAgain', 'Open again')}
                </Button>
              ) : null}
              {cancel(model.agent)}
            </>
          )
        case 'device': {
          const code = model.setup.userCode
          return (
            <>
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => actions.copyCodeAndOpen(model.agent, code)}
              >
                {t('vmBuildAgents.copyAndOpen', 'Copy code and open')}
              </Button>
              {cancel(model.agent)}
            </>
          )
        }
        case 'paste':
          return (
            <>
              <Button type="button" variant="outline" size="xs" onClick={actions.manage}>
                {t('vmBuildAgents.pasteToken', 'Paste token')}
              </Button>
              {cancel(model.agent)}
            </>
          )
        case 'preparing':
          return cancel(model.agent)
        case 'saving':
          return null
      }
      return null
    case 'failed':
      return (
        <>
          <Button type="button" variant="outline" size="xs" onClick={actions.setUp}>
            {t('vmBuildAgents.tryAgain', 'Try again')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => actions.dismissFailure(model.agent)}
          >
            {t('vmBuildAgents.dismiss', 'Dismiss')}
          </Button>
        </>
      )
    case 'expired':
      return (
        <Button type="button" size="xs" onClick={actions.setUp}>
          {t('vmBuildAgents.renew', 'Renew')}
        </Button>
      )
    case 'killSwitch':
      return queued ? (
        <Button type="button" variant="ghost" size="xs" onClick={actions.cancelSignInHere}>
          {t('vmBuildAgents.cancel', 'Cancel')}
        </Button>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => actions.signInHere(model.agent)}
        >
          {t('vmBuildAgents.signInHere', 'Sign in for this workspace')}
        </Button>
      )
    case 'desktopKey':
      return desktopKeySave.kind === 'failed' ? (
        <Button type="button" variant="outline" size="xs" onClick={actions.saveDesktopKey}>
          {t('vmBuildAgents.tryAgain', 'Try again')}
        </Button>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="xs"
          aria-disabled={desktopKeySave.kind === 'saving' || undefined}
          aria-busy={desktopKeySave.kind === 'saving' || undefined}
          onClick={desktopKeySave.kind === 'saving' ? undefined : actions.saveDesktopKey}
        >
          {desktopKeySave.kind === 'saving' ? <Loader2 className="animate-spin" /> : null}
          {t('cloudAgentSetup.desktopKeys.save', 'Save to your Orca account')}
        </Button>
      )
    case 'error':
      return (
        <Button type="button" variant="outline" size="xs" onClick={actions.retryLoad}>
          {t('vmBuildAgents.tryAgain', 'Try again')}
        </Button>
      )
    case 'loading':
    case 'hidden':
      return null
  }
}

function Lines({
  model,
  density,
  desktopKeySave,
  queued,
  t
}: {
  model: Exclude<BuildAgentsRowModel, { kind: 'hidden' }>
  density: BuildAgentsRowDensity
  desktopKeySave: DesktopKeySave
  queued: boolean
  t: Translate
}): React.JSX.Element {
  const line = density === 'line'
  if (model.kind === 'loading') {
    return (
      <>
        <span className="sr-only">{t('vmBuildAgents.checking', 'Checking agent sign-in')}</span>
        <Skeleton className="h-3.5 w-56" />
        {line ? null : <Skeleton className="h-3 w-72" />}
      </>
    )
  }
  if (model.kind === 'ready') {
    const text = readyLine(model, t)
    return (
      <>
        <span title={text} className="truncate text-foreground">
          {text}
        </span>
        {line ? null : (
          <span className="truncate text-xs text-muted-foreground">
            {t('vmBuildAgents.readyDetail', 'Every cloud workspace uses it. Nothing to do here.')}
          </span>
        )}
      </>
    )
  }
  const text = buildAgentsRowText(model, t)
  const detail =
    model.kind === 'desktopKey' && desktopKeySave.kind === 'failed'
      ? t('vmBuildAgents.keyFailed', 'Couldn’t save {{name}}. Nothing was changed.', {
          name: model.key.envName
        })
      : model.kind === 'killSwitch' && queued
        ? t('vmBuildAgents.queued', 'Opens when the sandbox is ready. Keep Orca open until then.')
        : text.detail
  const device = model.kind === 'setup' && model.setup.phase === 'device' ? model.setup : null
  return (
    <>
      <span title={device ? undefined : text.title} className="truncate text-foreground">
        {device ? (
          <>
            {t('vmBuildAgents.deviceEnter', 'Enter')}{' '}
            <code className="select-all rounded bg-muted px-1 font-mono text-xs tracking-wider">
              {device.userCode}
            </code>{' '}
            {t('vmBuildAgents.deviceOn', 'on {{host}}', {
              host: deviceHost(device.verificationUrl)
            })}
          </>
        ) : (
          text.title
        )}
        {text.tag ? <span className="text-xs text-muted-foreground"> · {text.tag}</span> : null}
      </span>
      {line ? (
        <span className="sr-only">{detail}</span>
      ) : (
        <span title={detail} className="truncate text-xs text-muted-foreground">
          {detail}
        </span>
      )}
    </>
  )
}

export function VmBuildCloudAgentsRowView({
  model,
  density,
  actions,
  menu,
  desktopKeySave = IDLE_SAVE,
  queued = false
}: {
  model: BuildAgentsRowModel
  density: BuildAgentsRowDensity
  actions: VmBuildCloudAgentsRowActions
  /** The ⋯ menu (S1-b); absent while loading or when it has nothing to offer. */
  menu?: React.ReactNode
  desktopKeySave?: DesktopKeySave
  queued?: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  if (model.kind === 'hidden') {
    return null
  }
  // Each state mounts fresh nodes: a reused button or line that changed width would count as a
  // layout shift even though the row itself never moves.
  const stateKey = [
    model.kind,
    model.kind === 'setup' ? model.setup.phase : '',
    desktopKeySave.kind,
    queued ? 'queued' : ''
  ].join(':')
  return (
    // A hairline: the agent row is not a build step.
    <li data-vm-build-cloud-agents={model.kind} className="mt-1 border-t border-border/60 pt-1">
      <div
        data-vm-build-cloud-agents-density={density}
        aria-busy={model.kind === 'loading' || undefined}
        className={cn(
          'flex items-center gap-2.5 overflow-hidden',
          density === 'line' ? 'h-8' : 'h-12'
        )}
      >
        <StatusIcon key={`icon:${stateKey}`} model={model} />
        <div
          role="status"
          className={cn(
            'flex min-w-0 flex-1 flex-col justify-center self-stretch',
            density === 'line' ? 'gap-0' : 'gap-0.5'
          )}
        >
          <Lines
            key={stateKey}
            model={model}
            density={density}
            desktopKeySave={desktopKeySave}
            queued={queued}
            t={t}
          />
        </div>
        {/* Fixed slots: the actions (184 px, redesign §5), then the ⋯ menu, which never moves. */}
        <div
          key={`actions:${stateKey}`}
          className="flex h-8 w-[184px] shrink-0 items-center justify-end gap-1"
        >
          <Trailing
            model={model}
            actions={actions}
            desktopKeySave={desktopKeySave}
            queued={queued}
            t={t}
          />
          {model.kind === 'ready' ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="text-muted-foreground"
              onClick={actions.manage}
            >
              {t('vmBuildAgents.manage', 'Manage')}
            </Button>
          ) : null}
        </div>
        <div className="flex size-6 shrink-0 items-center justify-center">{menu}</div>
      </div>
    </li>
  )
}
