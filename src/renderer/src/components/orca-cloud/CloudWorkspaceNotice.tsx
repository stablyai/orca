import React, { useId } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  CircleArrowUp,
  Loader2,
  MemoryStick,
  Plus,
  RefreshCw,
  RotateCw,
  TriangleAlert,
  Unplug,
  X
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { BANNER_BODY_TEXT, BANNER_TONE } from '@/components/ui/banner-tone'
import type { CloudOomEvent } from '../../../../shared/hosted-sandbox/cloud-workspace-api'

export type CloudNoticeKind = { kind: 'unresponsive' } | { kind: 'oom'; oom: CloudOomEvent }

/** Which side runs the older Orca when the two are outside each other's protocol range. */
export type CloudVersionSkewDirection = 'sandbox-older' | 'desktop-older'

/**
 * A quiet card in the workspace's top-right corner. Never covers or blocks the panes.
 */
function CloudNoticeCard({
  role = 'alert',
  noticeKind,
  icon: Icon,
  title,
  detail,
  action,
  onDismiss
}: {
  /** `alert` for a sandbox in trouble now; `status` for news from a background check. */
  role?: 'alert' | 'status'
  noticeKind: string
  icon: LucideIcon
  title: string
  detail: string
  action: React.ReactNode
  onDismiss?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const titleId = useId()
  // GA-P3t: trouble now reads as a warning; news from a background check as info.
  const tone = BANNER_TONE[role === 'alert' ? 'warning' : 'info']
  return (
    <div
      role={role}
      aria-labelledby={titleId}
      data-cloud-notice={noticeKind}
      className={cn(
        'pointer-events-auto flex w-[22rem] max-w-[calc(100%-1.5rem)] items-start gap-3 rounded-lg border p-3 text-card-foreground shadow-[0_8px_24px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_24px_rgba(0,0,0,0.4)] motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1',
        tone.surface,
        tone.border
      )}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', tone.icon)} aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="space-y-0.5">
          <div id={titleId} className="text-sm font-medium leading-5">
            {title}
          </div>
          <p className={cn('text-xs', BANNER_BODY_TEXT)}>{detail}</p>
        </div>
        {action}
      </div>
      {onDismiss ? (
        <Button
          size="icon-xs"
          variant="quiet"
          className="-mt-1 -mr-1"
          aria-label={t('orcaCloudWorkspace.dismiss', 'Dismiss')}
          onClick={onDismiss}
        >
          <X />
        </Button>
      ) : null}
    </div>
  )
}

/**
 * The workspace stopped answering, or a process ran out of memory. Both offer Restart (same disk).
 */
export function CloudWorkspaceNotice({
  notice,
  restarting,
  onRestart,
  onDismiss
}: {
  notice: CloudNoticeKind
  restarting: boolean
  onRestart: () => void
  onDismiss?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const isOom = notice.kind === 'oom'
  const victim = isOom ? notice.oom.victim : null
  const title = isOom
    ? victim
      ? t('orcaCloudWorkspace.oom.titleRan', '{{name}} ran out of memory', { name: victim })
      : t('orcaCloudWorkspace.oom.titleProcess', 'A process ran out of memory')
    : t('orcaCloudWorkspace.unresponsive.sandboxTitle', 'This sandbox isn’t responding')
  const detail = isOom
    ? t(
        'orcaCloudWorkspace.oom.stopped',
        'It was stopped so the sandbox stays up. Restart to recover.'
      )
    : t('orcaCloudWorkspace.detail.restartKeeps', 'Restart keeps your files; agents resume.')
  return (
    <CloudNoticeCard
      noticeKind={notice.kind}
      icon={isOom ? MemoryStick : Unplug}
      title={title}
      detail={detail}
      onDismiss={onDismiss}
      action={
        <Button size="xs" onClick={onRestart} disabled={restarting}>
          {restarting ? <Loader2 className="animate-spin" /> : <RotateCw />}
          {restarting
            ? t('orcaCloudWorkspace.restarting', 'Restarting…')
            : t('orcaCloudWorkspace.restart', 'Restart')}
        </Button>
      }
    />
  )
}

/**
 * This desktop and the sandbox's Orca are outside each other's protocol range (normal skew inside
 * the range shows nothing). A sandbox keeps the Orca it was created with, so an older sandbox is
 * fixed by a new workspace, a newer one by updating this computer.
 */
export function CloudVersionSkewNotice({
  direction,
  onCheckForUpdates,
  onCreateWorkspace,
  onDismiss
}: {
  direction: CloudVersionSkewDirection
  onCheckForUpdates: () => void
  onCreateWorkspace: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const desktopOlder = direction === 'desktop-older'
  return (
    <CloudNoticeCard
      role="status"
      noticeKind={`version-skew-${direction}`}
      icon={desktopOlder ? CircleArrowUp : TriangleAlert}
      title={
        desktopOlder
          ? t(
              'orcaCloudWorkspace.versionSkew.newerTitle',
              'This cloud workspace uses a newer version of Orca'
            )
          : t(
              'orcaCloudWorkspace.versionSkew.olderTitle',
              'This cloud workspace uses an older version of Orca'
            )
      }
      detail={
        desktopOlder
          ? t(
              'orcaCloudWorkspace.versionSkew.newerDetail',
              'Update Orca on this computer to connect to it. Your files are safe.'
            )
          : t(
              'orcaCloudWorkspace.versionSkew.olderDetail',
              'This version of Orca can’t connect to it, and restarting won’t update it. Your files are safe. New cloud workspaces use the current version.'
            )
      }
      onDismiss={onDismiss}
      action={
        desktopOlder ? (
          <Button size="xs" onClick={onCheckForUpdates}>
            <RefreshCw />
            {t('orcaCloudWorkspace.versionSkew.checkForUpdates', 'Check for updates')}
          </Button>
        ) : (
          <Button size="xs" onClick={onCreateWorkspace}>
            <Plus />
            {t('orcaCloudWorkspace.versionSkew.createWorkspace', 'Create workspace')}
          </Button>
        )
      }
    />
  )
}
