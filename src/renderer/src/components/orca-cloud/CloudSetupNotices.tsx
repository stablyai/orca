import React, { useEffect, useId, useRef, useState } from 'react'
import { GitPullRequestArrow, Loader2, Play, TriangleAlert, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { environmentCheckCopy } from '@/components/worktree-creation/environment-check-copy'
import type { CloudSetupNotice } from '@/lib/ephemeral-vm-environment-check-triage'
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

// After Install: GitHub's webhook usually lands within seconds, then the owner may take a while.
const FAST_POLL_MS = 2_000
const FAST_POLL_WINDOW_MS = 3 * 60_000
const SLOW_POLL_MS = 10_000
const GIVE_UP_MS = 30 * 60_000

export type CloudSetupNoticeLine = {
  text: string
  action: { label: string; icon: React.ReactNode; run: () => void; pending?: boolean } | null
}

export function cloudSetupNoticeLine(
  notice: CloudSetupNotice,
  record: Pick<CloudSetupNoticesRecord, 'repoUrl'>,
  t: Translate,
  handlers: { install: () => void; runSetup: () => void; installing: boolean }
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

/**
 * What the environment check found that didn't need to stop the create: one line per problem, one
 * action each, each dismissible. Sits with the workspace's other notices, top right.
 */
export function CloudSetupNotices({
  workspaceId
}: {
  workspaceId: string
}): React.JSX.Element | null {
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
  if (!record || notices.length === 0) {
    return null
  }
  return (
    <CloudSetupNoticesView
      record={record}
      notices={notices}
      installing={push.installing}
      onInstall={() => record.repoUrl && push.startInstall(record.repoUrl)}
      onRunSetup={(noticeId) => void runCloudSetupScript(workspaceId, record, noticeId)}
      onDismiss={(noticeId) => dismissCloudSetupNotice(record.environmentId, noticeId)}
    />
  )
}

export function CloudSetupNoticesView({
  record,
  notices,
  installing,
  onInstall,
  onRunSetup,
  onDismiss
}: {
  record: Pick<CloudSetupNoticesRecord, 'repoUrl'>
  notices: readonly CloudSetupNotice[]
  installing: boolean
  onInstall: () => void
  onRunSetup: (noticeId: string) => void
  onDismiss: (noticeId: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const labelId = useId()
  return (
    <section
      role="status"
      aria-labelledby={labelId}
      data-cloud-notice="setup"
      className="pointer-events-auto w-[26rem] max-w-[calc(100%-1.5rem)] rounded-lg border border-border bg-card text-card-foreground shadow-[0_8px_24px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_24px_rgba(0,0,0,0.4)] motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1"
    >
      <h2 id={labelId} className="sr-only">
        {t('orcaCloud.setupNotices.label', 'Workspace setup')}
      </h2>
      <ul className="divide-y divide-border">
        {notices.map((notice) => {
          const line = cloudSetupNoticeLine(notice, record, t, {
            install: onInstall,
            runSetup: () => onRunSetup(notice.id),
            installing
          })
          return (
            <li
              key={notice.id}
              data-cloud-setup-notice={notice.kind}
              className="flex items-start gap-2.5 px-3 py-2.5"
            >
              <TriangleAlert
                aria-hidden
                className="mt-0.5 size-3.5 shrink-0 text-status-warning-text"
              />
              {/* The sentence reads first; its one action sits under it so neither gets squeezed. */}
              <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
                <p className="text-xs leading-5 text-foreground">{line.text}</p>
                {line.action ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={line.action.pending ? undefined : line.action.run}
                    aria-disabled={line.action.pending || undefined}
                    aria-busy={line.action.pending || undefined}
                  >
                    {line.action.icon}
                    {line.action.label}
                  </Button>
                ) : null}
              </div>
              <Button
                type="button"
                size="icon-xs"
                variant="quiet"
                className="-mr-1 shrink-0"
                aria-label={t('orcaCloud.setupNotices.dismiss', 'Dismiss')}
                onClick={() => onDismiss(notice.id)}
              >
                <X />
              </Button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
