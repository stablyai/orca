import type React from 'react'
import type { RefObject } from 'react'
import { Loader2, Monitor, Play, RotateCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { cn } from '@/lib/class-names'
import { CLOUD_DOT_CLASS } from '@/components/orca-cloud/CloudStateDot'
import {
  runUnarchiveCloudWorkspace,
  wakeCloudWorkspace
} from '@/components/orca-cloud/cloud-workspace-actions'
import type { CloudDotState } from '@/lib/orca-cloud/orca-cloud-workspace-state'
import type { CloudDesktopPhase } from '@/lib/cloud-remote-desktop/use-cloud-desktop-connection'
import { actionLabel, failureCopy } from './CloudRemoteDesktopToast'
import { remoteDesktopReleaseChordLabel } from './RemoteDesktopKeyboardHint'

function phaseLabel(t: Translate, phase: CloudDesktopPhase): string {
  switch (phase.kind) {
    case 'connected':
      return t('components.cloudRemoteDesktop.tab.connected', 'Connected')
    case 'connecting':
      return t('components.cloudRemoteDesktop.tab.connecting', 'Connecting…')
    case 'reconnecting':
      return t('components.cloudRemoteDesktop.tab.reconnecting', 'Reconnecting…')
    case 'asleep':
      return t('orcaCloudWorkspace.state.asleep', 'Asleep')
    case 'waking':
      return t('components.cloudRemoteDesktop.tab.waking', 'Waking…')
    case 'archived':
      return t('orcaCloudWorkspace.state.archived', 'Archived')
    case 'wakeFailed':
      return t('orcaCloudWorkspace.state.wakeFailed', 'Couldn’t wake')
    case 'failed':
    case 'paused':
      return t('components.cloudRemoteDesktop.tab.disconnected', 'Disconnected')
  }
}

/** The status dot reuses the Orca Cloud state shapes (hollow asleep, half waking, …). */
function phaseDot(phase: CloudDesktopPhase): CloudDotState {
  switch (phase.kind) {
    case 'connected':
      return 'running'
    case 'connecting':
    case 'reconnecting':
    case 'waking':
      return 'waking'
    case 'asleep':
      return 'sleeping'
    case 'archived':
      return 'archived'
    case 'wakeFailed':
      return 'wakeFailed'
    case 'failed':
    case 'paused':
      return 'unresponsive'
  }
}

/** Replaces the address bar on a remote desktop tab: what it is, how it stands, Reconnect. */
export function CloudDesktopTabToolbar({
  chromeHeaderRef,
  phase,
  onReconnect
}: {
  chromeHeaderRef: RefObject<HTMLDivElement | null>
  phase: CloudDesktopPhase
  onReconnect: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const busy = phase.kind === 'reconnecting' || phase.kind === 'waking'
  const sandboxDown =
    phase.kind === 'asleep' || phase.kind === 'archived' || phase.kind === 'wakeFailed'
  return (
    <div ref={chromeHeaderRef} className="pointer-events-auto shrink-0">
      <div
        data-cloud-desktop-toolbar=""
        className="relative z-10 flex h-9 shrink-0 items-center gap-2 border-b border-border/70 bg-background/95 px-3"
      >
        <Monitor className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="text-xs font-medium text-foreground">
          {t('components.cloudRemoteDesktop.tabTitle', 'Remote desktop')}
        </span>
        <Badge variant="tag">{t('components.cloudRemoteDesktop.beta', 'Beta')}</Badge>
        <span
          role="status"
          className="ml-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
        >
          <span className={cn('size-2 shrink-0', CLOUD_DOT_CLASS[phaseDot(phase)])} aria-hidden />
          <span className="truncate">{phaseLabel(t, phase)}</span>
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {phase.kind === 'connected' ? (
            <span className="text-xs whitespace-nowrap text-muted-foreground">
              {t(
                'components.cloudRemoteDesktop.tab.releaseHint',
                '{{chord}} returns keys to Orca',
                {
                  chord: remoteDesktopReleaseChordLabel()
                }
              )}
            </span>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={busy || sandboxDown}
            onClick={onReconnect}
          >
            <RotateCw aria-hidden />
            {t('components.cloudRemoteDesktop.reconnect', 'Reconnect')}
          </Button>
        </span>
      </div>
    </div>
  )
}

function CoverCard({
  busy,
  title,
  detail,
  action
}: {
  busy?: boolean
  title: string
  detail?: string
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <div role="status" className="flex max-w-sm flex-col items-center gap-3 px-6 text-center">
      <span className="flex size-10 items-center justify-center rounded-full border border-border bg-muted/40 text-muted-foreground">
        {busy ? (
          <Loader2 className="size-5 motion-safe:animate-spin" aria-hidden />
        ) : (
          <Monitor className="size-5" aria-hidden />
        )}
      </span>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
      </div>
      {action}
    </div>
  )
}

/**
 * Over the desktop page whenever there is no live desktop to show: the sandbox is asleep (Wake),
 * waking (it reconnects by itself), archived, or reopening it failed. Connected, connecting and
 * paused pages show the page itself (noVNC paints its own connect and pause states).
 */
export function CloudDesktopTabCover({
  worktreeId,
  phase,
  onReconnect
}: {
  worktreeId: string
  phase: CloudDesktopPhase
  onReconnect: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  let body: React.ReactNode
  switch (phase.kind) {
    case 'connected':
    case 'connecting':
    case 'paused':
      return null
    case 'reconnecting':
      body = (
        <CoverCard
          busy
          title={t('components.cloudRemoteDesktop.tab.reconnectingTitle', 'Reconnecting…')}
        />
      )
      break
    case 'waking':
      body = (
        <CoverCard
          busy
          title={t('components.cloudRemoteDesktop.waking', 'Waking sandbox…')}
          detail={t(
            'components.cloudRemoteDesktop.tab.wakingDetail',
            'The remote desktop reconnects when it’s awake.'
          )}
        />
      )
      break
    case 'asleep':
    case 'wakeFailed': {
      const failed = phase.kind === 'wakeFailed'
      body = (
        <CoverCard
          title={
            failed
              ? t('components.cloudRemoteDesktop.wakeFailedTitle', 'Couldn’t wake the sandbox.')
              : t('components.cloudRemoteDesktop.tab.asleepTitle', 'This workspace is asleep.')
          }
          detail={
            failed
              ? t('components.cloudRemoteDesktop.wakeFailedDetail', 'Your files are safe.')
              : t(
                  'components.cloudRemoteDesktop.tab.asleepDetail',
                  'Wake it to reconnect. Apps that were open on the remote desktop need to be started again. Your files are safe.'
                )
          }
          action={
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => void wakeCloudWorkspace(worktreeId)}
            >
              <Play aria-hidden />
              {failed
                ? t('components.cloudRemoteDesktop.retry', 'Try again')
                : t('orcaCloudWorkspace.wake', 'Wake')}
            </Button>
          }
        />
      )
      break
    }
    case 'archived':
      body = (
        <CoverCard
          title={t('components.cloudRemoteDesktop.archivedTitle', 'This workspace is archived.')}
          detail={t(
            'components.cloudRemoteDesktop.archivedDetail',
            'Unarchive it to open the remote desktop. Your files are safe.'
          )}
          action={
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => void runUnarchiveCloudWorkspace(worktreeId)}
            >
              {t('components.cloudRemoteDesktop.unarchive', 'Unarchive')}
            </Button>
          }
        />
      )
      break
    case 'failed': {
      const copy = failureCopy(t, phase.code)
      const signIn = copy.action === 'sign_in'
      body = (
        <div className="w-full max-w-sm px-6">
          <InlineError
            title={copy.title}
            detail={copy.detail}
            tone={copy.tone}
            action={
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() =>
                  signIn ? void useAppStore.getState().connectCurrentOrcaProfile() : onReconnect()
                }
              >
                {signIn
                  ? actionLabel(t, 'sign_in')
                  : t('components.cloudRemoteDesktop.reconnect', 'Reconnect')}
              </Button>
            }
          />
        </div>
      )
      break
    }
  }
  return (
    <div
      data-cloud-desktop-cover={phase.kind}
      className="pointer-events-auto absolute inset-0 z-30 flex items-center justify-center bg-background"
    >
      {body}
    </div>
  )
}
