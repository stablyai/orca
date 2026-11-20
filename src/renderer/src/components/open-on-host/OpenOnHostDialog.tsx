import React, { useEffect, useId, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/class-names'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { getRuntimeGitUpstreamStatus } from '@/runtime/source-control/git/runtime-git-sync-client'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/github/refresh/worktree-refresh'
import { repoMatchesHostIdentity } from '@/store/repos/repo-host-identity'
import type { GitUpstreamStatus } from '../../../../shared/git/status/git-status-types'
import { resolveDeleteTargetGitContext } from '../sidebar/workspace-actions/deletion/use-delete-worktree-status-hydration'
import { branchDisplayName } from '../sidebar/workspace-card/identity/worktree-branch-display'
import { getWorkspaceSyncOffer, planWorkspaceOnHost } from './open-on-host-branch-plan'
import {
  getSourceHostLabel,
  resolveOpenOnHostLocation,
  runOpenOnHost,
  type OpenOnHostLocation
} from './open-on-host-flow'
import { useOpenOnHostTargets } from './use-open-on-host-targets'

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

const OpenOnHostDialog = React.memo(function OpenOnHostDialog() {
  const t = useTranslate()
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const sourceHostId = readString(modalData.sourceHostId)
  const worktreeId = readString(modalData.worktreeId)
  const repo = useAppStore((s) =>
    s.repos.find((candidate) =>
      repoMatchesHostIdentity(candidate, readString(modalData.repoId), sourceHostId)
    )
  )
  const worktree = useAppStore((s) =>
    worktreeId ? findWorktreeById(s, worktreeId, sourceHostId) : null
  )
  const options = useOpenOnHostTargets(repo, !!worktreeId)
  // Why: a snapshot, so host status ticks while the dialog is open don't reload the location.
  const [opened] = useState(() => ({
    options,
    worktree,
    target: options?.targets.find((candidate) => candidate.hostId === modalData.targetHostId)
  }))
  const { target } = opened
  const cloneUrl = opened.options?.cloneUrl ?? ''
  const [location, setLocation] = useState<OpenOnHostLocation | null>(null)
  const [upstream, setUpstream] = useState<GitUpstreamStatus | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [syncFirst, setSyncFirst] = useState(true)
  const [opening, setOpening] = useState(false)
  const syncCheckboxId = useId()

  useEffect(() => {
    // Why: a missing workspace must not fall through to the project flow.
    if (!target || (worktreeId && !opened.worktree)) {
      closeModal()
      return
    }
    let cancelled = false
    const source = opened.worktree
    const ctx = source ? resolveDeleteTargetGitContext(source, useAppStore.getState().repos) : null
    void Promise.all([
      resolveOpenOnHostLocation(target, cloneUrl),
      source && ctx ? getRuntimeGitUpstreamStatus(ctx, source.pushTarget) : null
    ]).then(
      ([nextLocation, nextUpstream]) => {
        if (cancelled) {
          return
        }
        setLocation(nextLocation)
        setUpstream(nextUpstream)
        if (source && !ctx) {
          setLoadError(
            translate('openOnHost.sourceUnavailable', "Can't reach the host of this workspace")
          )
        }
      },
      (error: unknown) => {
        // Why: an unreachable host rejects here; show it instead of a dialog stuck loading.
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error))
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [target, cloneUrl, opened.worktree, worktreeId, closeModal])

  if (!target || !repo || (worktreeId && !opened.worktree)) {
    return null
  }
  const source = opened.worktree
  const branch = source ? branchDisplayName(source.branch) : ''
  const offer = upstream ? getWorkspaceSyncOffer(upstream, branch, source?.pushTarget) : 'none'
  const plan =
    source && upstream
      ? planWorkspaceOnHost({ branch, upstream, pushTarget: source.pushTarget, syncFirst })
      : null
  const host = target.label
  const locationLine =
    location?.kind === 'existing'
      ? t('openOnHost.existingLocation', 'Opens in {{path}}', { path: location.path })
      : location?.kind === 'clone'
        ? t('openOnHost.cloneLocation', 'Clone from {{url}} into {{path}}', {
            url: location.url,
            path: location.folderName
              ? `${location.destination}/${location.folderName}`
              : location.destination
          })
        : location?.kind === 'unavailable'
          ? location.reason
          : t('openOnHost.checking', 'Checking {{host}}…', { host })
  const blockedLine =
    plan?.kind === 'blocked'
      ? plan.reason === 'detached'
        ? t('openOnHost.detached', 'Check out a branch to open this workspace on {{host}}', {
            host
          })
        : t(
            'openOnHost.unpublishedBlocked',
            "{{branch}} is not on a remote yet, so {{host}} can't fetch it. Publish it first",
            { branch, host }
          )
      : plan?.kind === 'ready' && plan.localOnlyCommits > 0
        ? t('openOnHost.localCommitsStay', 'Your {{count}} local commits stay on {{source}}', {
            count: plan.localOnlyCommits,
            source: getSourceHostLabel(source?.hostId),
            defaultValue_one: 'Your {{count}} local commit stays on {{source}}'
          })
        : null
  const readyLocation = location && location.kind !== 'unavailable' ? location : null
  const canOpen = !opening && !loadError && !!readyLocation && (!source || plan?.kind === 'ready')

  const handleOpen = async (): Promise<void> => {
    if (!readyLocation || !opened.options || (source && plan?.kind !== 'ready')) {
      return
    }
    setOpening(true)
    const result = await runOpenOnHost({
      projectId: opened.options.projectId,
      displayName: repo.displayName,
      target,
      location: readyLocation,
      workspace: source && plan?.kind === 'ready' ? { worktree: source, plan } : undefined
    })
    if (!result) {
      // runOpenOnHost already toasted why; leave the dialog open to retry.
      setOpening(false)
      return
    }
    // Only close our own modal; another may have replaced it meanwhile.
    // After a post-clone failure the menu reopens on the new clone instead of cloning again.
    if (useAppStore.getState().activeModal === 'open-on-host') {
      closeModal()
    }
    if (result !== 'failed-after-clone' && result.notice) {
      toast.warning(result.notice)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && closeModal()}>
      <DialogContent busy={opening} className="max-w-md sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {t('openOnHost.title', 'Open {{name}} on {{host}}', {
              name: source?.displayName ?? repo.displayName,
              host
            })}
          </DialogTitle>
          <DialogDescription className="break-all">{loadError ?? locationLine}</DialogDescription>
        </DialogHeader>
        {source && !loadError ? (
          <div className="flex flex-col gap-2 text-sm">
            <div>{t('openOnHost.branch', 'Branch {{branch}}', { branch })}</div>
            {offer === 'push' || offer === 'publish' ? (
              <div className="flex items-center gap-2">
                <Checkbox
                  id={syncCheckboxId}
                  checked={syncFirst}
                  disabled={opening}
                  onCheckedChange={(checked) => setSyncFirst(checked === true)}
                />
                <Label htmlFor={syncCheckboxId}>
                  {offer === 'push'
                    ? t('openOnHost.pushFirst', 'Push {{branch}} first', { branch })
                    : t('openOnHost.publishFirst', 'Publish {{branch}} first', { branch })}
                </Label>
              </div>
            ) : null}
            {blockedLine ? <div className="text-muted-foreground">{blockedLine}</div> : null}
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" disabled={opening} onClick={closeModal}>
            {t('openOnHost.cancel', 'Cancel')}
          </Button>
          <Button disabled={!canOpen} onClick={() => void handleOpen()}>
            {/* Both labels share one grid cell so the swap doesn't resize the button. */}
            <span className="inline-grid">
              <span
                aria-hidden={!opening}
                className={cn(
                  'col-start-1 row-start-1 inline-flex items-center justify-center gap-2',
                  !opening && 'invisible'
                )}
              >
                <Loader2 className="size-4 animate-spin" />
                {t('openOnHost.opening', 'Opening…')}
              </span>
              <span
                aria-hidden={opening}
                className={cn('col-start-1 row-start-1', opening && 'invisible')}
              >
                {t('openOnHost.primary', 'Open on {{host}}', { host })}
              </span>
            </span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default OpenOnHostDialog
