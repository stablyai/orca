import React from 'react'
import { CircleSlash, ExternalLink, Github } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { CloudCreateGitHubAccess } from '@/lib/orca-cloud/cloud-create-github-access'
import {
  openCloudCreateGitHubAccess,
  recheckCloudCreateGitHubAccess,
  reopenCloudCreateGitHubAccess,
  skipCloudCreateGitHubAccess
} from '@/lib/orca-cloud/cloud-create-github-access-actions'
import { useCloudCreateGitHubAccess } from '@/lib/orca-cloud/cloud-create-github-access-registry'
import { ownerRequestLabel, useOwnerRequestCopy } from '@/lib/orca-cloud/owner-request'
import { StepIcon } from './WorktreeSetupSteps'
import { VmBuildGitHubIdentityLine } from './VmBuildGitHubIdentityLine'

type VmBuildGitHubAccessActions = {
  open: () => void
  skip: () => void
  /** "Open now, set up later": this create goes on; the next one asks again. */
  openNow: () => void
  reopen: () => void
  copyRequest: () => void
  copied: boolean
}

function stepState(phase: CloudCreateGitHubAccess['phase']): 'running' | 'done' | 'pending' {
  switch (phase) {
    case 'checking':
      return 'running'
    case 'ok':
    case 'granted':
      return 'done'
    case 'needed':
    case 'skipped':
    case 'hidden':
      return 'pending'
  }
}

function askLine(access: CloudCreateGitHubAccess, t: Translate): string {
  switch (access.ask) {
    case 'configure':
      return t(
        'orcaCloud.createGitHubAccess.configureMeaning',
        'Orca’s GitHub app is on {{owner}}, but not for this repository. You can pull without it; pushes need it.',
        { owner: access.owner }
      )
    case 'request':
      return t(
        'orcaCloud.createGitHubAccess.requestMeaning',
        'Only an owner of {{owner}} can install Orca’s GitHub app. You can pull without it; pushes need it.',
        { owner: access.owner }
      )
    case 'requested':
      return t(
        'orcaCloud.createGitHubAccess.requestedMeaning',
        'An owner of {{owner}} has been asked to approve Orca’s GitHub app. This continues on its own once they do.',
        { owner: access.owner }
      )
    case 'install':
    case undefined:
      return t(
        'orcaCloud.createGitHubAccess.installMeaning',
        'Install Orca’s GitHub app on {{owner}} so this workspace can push. You can pull without it.',
        { owner: access.owner }
      )
  }
}

/**
 * The wizard's "GitHub access" step, drawn like the steps around it: a check mark
 * when the Orca GitHub App can push, otherwise what grants it, and Skip for now.
 */
export function VmBuildGitHubAccessRowView({
  access,
  actions,
  identityLine = null
}: {
  access: CloudCreateGitHubAccess
  actions: VmBuildGitHubAccessActions
  /** "Connect your GitHub so PRs show as you", once access is settled. */
  identityLine?: React.ReactNode
}): React.JSX.Element | null {
  const t = useTranslate()
  const labelId = React.useId()
  if (access.phase === 'hidden') {
    return null
  }
  const needed = access.phase === 'needed'
  const skipped = access.phase === 'skipped'
  const repo = access.repoName
  const label = needed
    ? t('orcaCloud.createGitHubAccess.needed', 'Let Orca push to {{repo}}', { repo })
    : t('orcaCloud.createGitHubAccess.label', 'GitHub access')
  const detail =
    access.phase === 'granted'
      ? t('orcaCloud.createGitHubAccess.granted', 'Orca can push to {{repo}} now.', { repo })
      : skipped
        ? t(
            'orcaCloud.createGitHubAccess.skippedMeaning',
            'You can pull; pushes need access later.'
          )
        : null

  return (
    <li
      data-vm-build-github-access={access.phase}
      className="flex flex-col gap-1 py-1.5"
      aria-current={needed ? 'step' : undefined}
      aria-labelledby={labelId}
    >
      <div className="flex items-center gap-2.5">
        {skipped ? (
          <CircleSlash aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        ) : needed ? (
          <Github aria-hidden className="size-3.5 shrink-0 text-foreground" />
        ) : (
          <StepIcon state={stepState(access.phase)} />
        )}
        <span
          id={labelId}
          className={cn('min-w-0 flex-1 truncate', skipped && 'text-muted-foreground')}
        >
          {label}
        </span>
        {access.phase === 'checking' ? (
          <span className="text-xs text-muted-foreground">
            {t('orcaCloud.createGitHubAccess.checking', 'Checking…')}
          </span>
        ) : null}
        {skipped ? (
          <>
            <span className="text-xs text-muted-foreground">
              {t('auto.components.worktree.creation.VmBuildSheet.stateSkipped', 'Skipped')}
            </span>
            {access.ask ? (
              <Button type="button" variant="ghost" size="xs" onClick={actions.reopen}>
                {t('orcaCloud.createGitHubAccess.setUp', 'Set up')}
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
      {detail ? <p className="ml-6 text-xs text-muted-foreground">{detail}</p> : null}
      {access.phase === 'ok' || access.phase === 'granted' || access.phase === 'skipped'
        ? identityLine
        : null}
      {needed ? (
        <div className="ml-6 flex flex-col gap-2 pb-1">
          <p className="text-xs text-muted-foreground">{askLine(access, t)}</p>
          {access.opened ? (
            <p role="status" className="text-xs text-muted-foreground">
              {t(
                'orcaCloud.createGitHubAccess.waiting',
                'Waiting for GitHub… This continues on its own once access is granted.'
              )}
            </p>
          ) : null}
          {access.holding ? (
            <p role="status" className="text-xs text-foreground">
              {t(
                'orcaCloud.createGitHubAccess.holding',
                'Your sandbox is ready. It opens as soon as you grant access or skip.'
              )}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {/* Held a while with no answer: opening leads; granting stays one click away. */}
            {access.holdingLong ? (
              <Button type="button" size="xs" onClick={actions.openNow}>
                {t('orcaCloud.createGitHubAccess.openNow', 'Open now, set up later')}
              </Button>
            ) : null}
            {access.ask === 'install' || access.ask === 'configure' ? (
              <Button
                type="button"
                size="xs"
                variant={access.holdingLong ? 'outline' : 'default'}
                onClick={actions.open}
              >
                <ExternalLink aria-hidden />
                {access.ask === 'configure'
                  ? t('orcaCloud.createGitHubAccess.configure', 'Add repository on GitHub')
                  : t('orcaCloud.createGitHubAccess.install', 'Install GitHub App')}
              </Button>
            ) : (
              <Button type="button" size="xs" variant="outline" onClick={actions.copyRequest}>
                {ownerRequestLabel(actions.copied, t)}
              </Button>
            )}
            <Button type="button" size="xs" variant="ghost" onClick={actions.skip}>
              {t('orcaCloud.createGitHubAccess.skip', 'Skip for now')}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  )
}

/** The live step for a create; nothing when the create has no GitHub step. */
export function VmBuildGitHubAccessRow({
  creationId
}: {
  creationId: string
}): React.JSX.Element | null {
  const access = useCloudCreateGitHubAccess(creationId)
  const request = useOwnerRequestCopy(access?.repoUrl ?? null, 'push')
  const needed = access?.phase === 'needed'
  // An install finished in the browser: check as soon as Orca is focused again.
  React.useEffect(() => {
    if (!needed) {
      return
    }
    const onFocus = (): void => recheckCloudCreateGitHubAccess(creationId)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [creationId, needed])
  if (!access) {
    return null
  }
  return (
    <VmBuildGitHubAccessRowView
      access={access}
      identityLine={<VmBuildGitHubIdentityLine />}
      actions={{
        open: () => openCloudCreateGitHubAccess(creationId),
        skip: () => skipCloudCreateGitHubAccess(creationId),
        openNow: () => skipCloudCreateGitHubAccess(creationId, { remember: false }),
        reopen: () => reopenCloudCreateGitHubAccess(creationId),
        copyRequest: request.copy,
        copied: request.copied
      }}
    />
  )
}
