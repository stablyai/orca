import React from 'react'
import { MonitorUp } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { isGitRepoKind } from '../../../../shared/repository/repo-kind'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { useOpenOnHostTargets } from './use-open-on-host-targets'

/** "Open on <host>…" for each runtime host; a worktree item opens that branch there. */
export function OpenOnHostMenuItems({
  repo,
  worktree
}: {
  repo: Repo
  worktree?: Worktree
}): React.JSX.Element | null {
  const t = useTranslate()
  const openModal = useAppStore((s) => s.openModal)
  // Folder workspaces have no git branch to carry over.
  const options = useOpenOnHostTargets(isGitRepoKind(repo) ? repo : null, !!worktree)
  if (!options) {
    return null
  }
  return (
    <>
      {options.targets.map((target) => {
        const reason =
          worktree && !worktree.branch
            ? t('openOnHost.detached', 'Check out a branch to open this workspace on {{host}}', {
                host: target.label
              })
            : target.disabledReason
        return (
          <DropdownMenuItem
            key={target.hostId}
            disabled={!!reason}
            onSelect={() =>
              openModal('open-on-host', {
                repoId: repo.id,
                sourceHostId: options.sourceHostId,
                targetHostId: target.hostId,
                worktreeId: worktree?.id
              })
            }
          >
            <MonitorUp className="size-3.5" />
            {worktree
              ? t('openOnHost.workspaceMenu', 'Open on {{host}}…', { host: target.label })
              : t('openOnHost.projectMenu', 'Open on {{host}}…', { host: target.label })}
            {reason ? (
              <span className="ml-auto shrink-0 text-2xs text-muted-foreground">{reason}</span>
            ) : null}
          </DropdownMenuItem>
        )
      })}
    </>
  )
}
