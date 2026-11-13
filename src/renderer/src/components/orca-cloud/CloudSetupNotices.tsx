import React, { useEffect, useRef, useState } from 'react'
import { Loader2, Play, RefreshCw } from 'lucide-react'
import { useAppStore } from '@/store'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import {
  missingToolCommand,
  type CloudSetupNotice
} from '@/runtime/ephemeral-vm/ephemeral-vm-environment-check-triage'
import {
  dismissCloudSetupNotice,
  useCloudSetupNoticesSnapshot,
  visibleCloudSetupNotices,
  type CloudSetupNoticesRecord
} from '@/lib/orca-cloud/cloud-setup-notices-store'
import { repoSlug, runCloudSetupScript } from '@/lib/orca-cloud/cloud-setup-notice-actions'
import { recheckCloudFetch } from '@/lib/orca-cloud/cloud-fetch-notice'
import { runVmEnvironmentCheck } from '@/runtime/ephemeral-vm/ephemeral-vm-environment-check'
import { hideCloudToast, showCloudToast, type CloudToastView } from './cloud-toast-stack'
import { cloudPushNoticeLine, type CloudPushLineHandlers } from './cloud-push-notice-line'
import { useCloudPushNotice } from './use-cloud-push-notice'

export type CloudSetupNoticeLine = {
  text: string
  /** A muted second line: what it means for the person. */
  description?: string
  action: {
    label: string
    icon: React.ReactNode
    run: () => void
    pending?: boolean
  } | null
}

export type CloudSetupNoticeHandlers = {
  push: CloudPushLineHandlers
  runSetup: () => void
  recheckFetch?: () => void
  checkingFetch?: boolean
}

export function cloudSetupNoticeLine(
  notice: CloudSetupNotice,
  record: Pick<CloudSetupNoticesRecord, 'repoUrl'>,
  t: Translate,
  handlers: CloudSetupNoticeHandlers
): CloudSetupNoticeLine {
  switch (notice.kind) {
    case 'push':
      return cloudPushNoticeLine(record.repoUrl, t, handlers.push)
    case 'fetch':
      // ENV-ORIGIN-TOAST: shown only after a confirming check also failed; Check again re-runs it.
      return {
        text: record.repoUrl
          ? t(
              'orcaCloud.setupNotices.fetchFailed',
              'This workspace can’t reach {{repo}} on GitHub right now.',
              { repo: repoSlug(record.repoUrl) }
            )
          : t(
              'orcaCloud.setupNotices.fetchFailedNoRepo',
              'This workspace can’t reach its Git remote right now.'
            ),
        description: t(
          'orcaCloud.setupNotices.fetchFailedMeaning',
          'Pulls and pushes won’t work until it can.'
        ),
        action: handlers.recheckFetch
          ? {
              label: handlers.checkingFetch
                ? t('orcaCloud.setupNotices.checking', 'Checking…')
                : t('orcaCloud.setupNotices.checkAgain', 'Check again'),
              icon: handlers.checkingFetch ? <Loader2 className="animate-spin" /> : <RefreshCw />,
              run: handlers.recheckFetch,
              ...(handlers.checkingFetch ? { pending: true } : {})
            }
          : null
      }
    case 'setup':
      return {
        text: t('orcaCloud.setupNotices.setupNotRun', 'Setup script hasn’t run yet'),
        action: {
          label: t('orcaCloud.setupNotices.runSetup', 'Run setup script'),
          icon: <Play />,
          run: handlers.runSetup
        }
      }
    case 'tool': {
      // Orca can't install it for the person; the words say where it goes.
      const command = missingToolCommand(notice.check)
      const reason = notice.check.params?.reason
      return {
        text: reason
          ? t(
              'orcaCloud.setupNotices.toolMissing',
              '{{command}} isn’t installed in this sandbox, but {{reason}} needs it.',
              { command, reason }
            )
          : t(
              'orcaCloud.setupNotices.toolMissingNoReason',
              '{{command}} isn’t installed in this sandbox.',
              { command }
            ),
        description: t(
          'orcaCloud.setupNotices.toolMissingMeaning',
          'Install it from a terminal here, or add it to your project’s setup script so new workspaces have it.'
        ),
        action: null
      }
    }
    case 'disk':
      // A sandbox's disk can't be grown from Orca, so no button: only what to expect.
      return {
        text: t(
          'orcaCloud.setupNotices.diskLow',
          'Only {{free}} GB of disk space is free in this sandbox.',
          { free: notice.check.params?.free ?? '' }
        ),
        description:
          notice.check.code === 'diskVeryLow'
            ? t(
                'orcaCloud.setupNotices.diskVeryLowMeaning',
                'Installs and builds may fail. Delete caches or build output you don’t need.'
              )
            : t(
                'orcaCloud.setupNotices.diskLowMeaning',
                'Large dependency installs may run out of space.'
              ),
        action: null
      }
  }
}

/** Check again on the "can't reach GitHub" line: one doctor run at a time. */
function useFetchRecheck(environmentId: string | undefined): {
  checking: boolean
  recheck: () => void
} {
  const [checking, setChecking] = useState(false)
  const busy = useRef(false)
  return {
    checking,
    recheck: () => {
      if (!environmentId || busy.current) {
        return
      }
      busy.current = true
      setChecking(true)
      void recheckCloudFetch(environmentId, runVmEnvironmentCheck).finally(() => {
        busy.current = false
        setChecking(false)
      })
    }
  }
}

/** The notices as a shared cloud toast view (DS-q chrome: ⚠ warnings, outline actions). */
export function cloudSetupNoticesView(
  record: Pick<CloudSetupNoticesRecord, 'repoUrl' | 'environmentId'>,
  notices: readonly CloudSetupNotice[],
  t: Translate,
  handlers: {
    push: CloudPushLineHandlers
    runSetup: (noticeId: string) => void
    dismiss: (noticeId: string) => void
    recheckFetch?: () => void
    checkingFetch?: boolean
  }
): CloudToastView {
  return {
    priority: 'warning',
    label: t('orcaCloud.setupNotices.label', 'Workspace setup'),
    lines: notices.map((notice) => {
      const line = cloudSetupNoticeLine(notice, record, t, {
        push: handlers.push,
        runSetup: () => handlers.runSetup(notice.id),
        ...(handlers.recheckFetch ? { recheckFetch: handlers.recheckFetch } : {}),
        ...(handlers.checkingFetch ? { checkingFetch: true } : {})
      })
      return {
        key: notice.id,
        text: line.text,
        ...(line.description ? { description: line.description } : {}),
        ...(line.action
          ? {
              action: {
                label: line.action.label,
                icon: line.action.icon,
                onClick: line.action.run,
                ...(line.action.pending ? { pending: true } : {})
              }
            }
          : {}),
        onDismissLine: () => handlers.dismiss(notice.id)
      }
    })
  }
}

/**
 * What the environment check found that didn't need to stop the create: one line per problem, one
 * action each, each dismissible. It is one of the shared cloud toasts (DS-o/DS-q): it stacks with
 * the others, a warning below any action-required prompt. Shown while its workspace is the active
 * one; leaving the workspace (or its sleep) takes it down again.
 */
export function CloudSetupNoticesDock({ workspaceId }: { workspaceId: string }): null {
  const t = useTranslate()
  const environmentId = useAppStore(
    (state) => state.ephemeralVmRuntimesByWorkspaceId?.[workspaceId]?.runtimeEnvironmentId
  )
  const snapshot = useCloudSetupNoticesSnapshot()
  const record = environmentId ? snapshot.records[environmentId] : undefined
  const notices = visibleCloudSetupNotices(snapshot, environmentId)
  const push = useCloudPushNotice(
    environmentId,
    record?.repoUrl ?? null,
    notices.some((notice) => notice.kind === 'push')
  )
  const fetch = useFetchRecheck(environmentId)
  const toastId = environmentId ? cloudSetupToastId(environmentId) : null
  const shown = Boolean(record) && notices.length > 0
  // Showing the same id again updates the toast in place (installing state, a dismissed line).
  useEffect(() => {
    if (!toastId) {
      return
    }
    if (!record || !shown) {
      hideCloudToast(toastId)
      return
    }
    cancelPendingHide(toastId)
    showCloudToast(
      toastId,
      cloudSetupNoticesView(record, notices, t, {
        push,
        runSetup: (noticeId) => void runCloudSetupScript(workspaceId, record, noticeId),
        dismiss: (noticeId) => dismissCloudSetupNotice(record.environmentId, noticeId),
        recheckFetch: fetch.recheck,
        checkingFetch: fetch.checking
      }),
      // N-03: only over its own workspace; never over Settings or another workspace.
      { scope: { workspaceId } }
    )
  })
  useEffect(
    () => () => {
      if (toastId) {
        hideSoon(toastId)
      }
    },
    [toastId]
  )
  return null
}

// A remount (StrictMode, a re-keyed surface) shows the toast again in the same tick, so take it down
// only once nothing has claimed the id back.
const pendingHide = new Map<string, ReturnType<typeof setTimeout>>()

function hideSoon(toastId: string): void {
  cancelPendingHide(toastId)
  pendingHide.set(
    toastId,
    setTimeout(() => {
      pendingHide.delete(toastId)
      hideCloudToast(toastId)
    }, 0)
  )
}

function cancelPendingHide(toastId: string): void {
  const timer = pendingHide.get(toastId)
  if (timer !== undefined) {
    clearTimeout(timer)
    pendingHide.delete(toastId)
  }
}

export function cloudSetupToastId(environmentId: string): string {
  return `cloud-setup:${environmentId}`
}
