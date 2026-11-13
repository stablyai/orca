import React, { useEffect, useRef, useState } from 'react'
import { GitPullRequestArrow, Loader2, Play, RefreshCw } from 'lucide-react'
import { useAppStore } from '@/store'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { environmentCheckCopy } from '@/components/worktree-creation/environment-check-copy'
import type { CloudSetupNotice } from '@/runtime/ephemeral-vm/ephemeral-vm-environment-check-triage'
import {
  dismissCloudSetupNotice,
  useCloudSetupNoticesSnapshot,
  visibleCloudSetupNotices,
  type CloudSetupNoticesRecord
} from '@/lib/orca-cloud/cloud-setup-notices-store'
import {
  openOrcaGitHubAppInstall,
  recheckCloudPushAccess,
  repoOwner,
  repoSlug,
  runCloudSetupScript
} from '@/lib/orca-cloud/cloud-setup-notice-actions'
import { recheckCloudFetch } from '@/lib/orca-cloud/cloud-fetch-notice'
import { runVmEnvironmentCheck } from '@/runtime/ephemeral-vm/ephemeral-vm-environment-check'
import { hideCloudToast, showCloudToast, type CloudToastView } from './cloud-toast-stack'

// After Install: GitHub's webhook usually lands within seconds, then the owner may take a while.
const FAST_POLL_MS = 2_000
const FAST_POLL_WINDOW_MS = 3 * 60_000
const SLOW_POLL_MS = 10_000
const GIVE_UP_MS = 30 * 60_000

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

export function cloudSetupNoticeLine(
  notice: CloudSetupNotice,
  record: Pick<CloudSetupNoticesRecord, 'repoUrl'>,
  t: Translate,
  handlers: {
    install: () => void
    runSetup: () => void
    installing: boolean
    recheckFetch?: () => void
    checkingFetch?: boolean
  }
): CloudSetupNoticeLine {
  switch (notice.kind) {
    case 'push':
      if (record.repoUrl) {
        const owner = repoOwner(record.repoUrl)
        return {
          text: t(
            'orcaCloud.setupNotices.pushNeedsApp',
            'Orca Cloud can read {{repo}} but can’t push yet. Install the Orca GitHub App on {{owner}} to push.',
            { repo: repoSlug(record.repoUrl), owner }
          ),
          action: {
            label: handlers.installing
              ? t('orcaCloud.setupNotices.waitingForGitHub', 'Waiting for GitHub…')
              : t('orcaCloud.setupNotices.installOn', 'Install on {{owner}}', { owner }),
            icon: handlers.installing ? (
              <Loader2 className="animate-spin" />
            ) : (
              <GitPullRequestArrow />
            ),
            run: handlers.install,
            pending: handlers.installing
          }
        }
      }
      return {
        text: t('orcaCloud.setupNotices.pushRefused', 'Orca Cloud can’t push from this workspace.'),
        action: null
      }
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
    case 'check':
      return { text: environmentCheckCopy(notice.check, t, true).message, action: null }
  }
}

/** Polls repo access after Install until the push works, GitHub refuses it, or it gives up. */
function usePushRecheck(
  environmentId: string | undefined,
  hasPush: boolean
): {
  installing: boolean
  startInstall: (repoUrl: string) => void
} {
  const [installStartedAt, setInstallStartedAt] = useState<number | null>(null)
  const [tick, setTick] = useState(0)
  const busy = useRef(false)

  useEffect(() => {
    if (!environmentId || !hasPush || installStartedAt === null) {
      return
    }
    const elapsed = Date.now() - installStartedAt
    if (elapsed > GIVE_UP_MS) {
      setInstallStartedAt(null)
      return
    }
    const timer = setTimeout(
      () => {
        if (busy.current) {
          setTick((n) => n + 1)
          return
        }
        busy.current = true
        void recheckCloudPushAccess(environmentId)
          .then((result) => {
            if (result !== 'waiting') {
              setInstallStartedAt(null)
            }
          })
          .finally(() => {
            busy.current = false
            setTick((n) => n + 1)
          })
      },
      elapsed < FAST_POLL_WINDOW_MS ? FAST_POLL_MS : SLOW_POLL_MS
    )
    return () => clearTimeout(timer)
  }, [environmentId, hasPush, installStartedAt, tick])

  // Installed somewhere else (the browser, another device): check again when Orca is focused.
  useEffect(() => {
    if (!environmentId || !hasPush) {
      return
    }
    const onFocus = (): void => {
      if (!busy.current) {
        busy.current = true
        void recheckCloudPushAccess(environmentId).finally(() => {
          busy.current = false
        })
      }
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [environmentId, hasPush])

  return {
    installing: installStartedAt !== null,
    startInstall: (repoUrl) => {
      void openOrcaGitHubAppInstall(repoUrl).then((opened) => {
        if (opened) {
          setInstallStartedAt(Date.now())
        }
      })
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
    installing: boolean
    install: () => void
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
        install: handlers.install,
        runSetup: () => handlers.runSetup(notice.id),
        installing: handlers.installing,
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
  const push = usePushRecheck(
    environmentId,
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
        installing: push.installing,
        install: () => record.repoUrl && push.startInstall(record.repoUrl),
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
