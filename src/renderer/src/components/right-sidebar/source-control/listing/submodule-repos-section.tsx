import React, { useState } from 'react'
import { ArrowDownToLine, ArrowUp, CloudDownload, GitBranch } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { GitSubmoduleRepo } from '../../../../../../shared/git-submodule-repo-types'
import { ActionButton } from './action-button'
import { SectionHeader } from './section-header'
import type {
  SubmoduleRepoAction,
  UseSourceControlSubmoduleReposResult
} from './use-submodule-repos'

export function submoduleRepoActionsEnabled(
  repo: GitSubmoduleRepo
): Record<SubmoduleRepoAction, boolean> {
  const hasBranch = repo.branch !== null
  return {
    fetch: true,
    // Pull needs a branch that tracks something.
    pull: hasBranch && repo.upstream?.hasUpstream === true,
    // A branch with no upstream is published by the first push.
    push: hasBranch && (repo.upstream?.hasUpstream !== true || repo.upstream.ahead > 0)
  }
}

function SubmoduleRepoRow({
  repo,
  anyBusy,
  onAction
}: {
  repo: GitSubmoduleRepo
  anyBusy: boolean
  onAction: (action: SubmoduleRepoAction) => void
}): React.JSX.Element {
  const enabled = submoduleRepoActionsEnabled(repo)
  const name = repo.path.split('/').pop() ?? repo.path
  const { ahead = 0, behind = 0 } = repo.upstream ?? {}
  return (
    <div
      className="group/row flex items-center gap-1 py-0.5 pl-6 pr-3"
      data-testid="submodule-repo-row"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs" title={repo.path}>
          {name}
        </div>
        <div className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
          <GitBranch className="size-3 shrink-0" />
          <span className="truncate">
            {repo.branch ??
              translate(
                'auto.components.right.sidebar.SourceControl.submoduleDetached',
                'Detached HEAD'
              )}
          </span>
          {ahead > 0 || behind > 0 ? (
            <span className="shrink-0 tabular-nums">
              {behind > 0 ? `↓${behind}` : ''}
              {ahead > 0 ? `↑${ahead}` : ''}
            </span>
          ) : null}
        </div>
      </div>
      <ActionButton
        icon={CloudDownload}
        title={translate(
          'auto.components.right.sidebar.SourceControl.submoduleFetch',
          'Fetch {{value0}}',
          {
            value0: name
          }
        )}
        disabled={anyBusy || !enabled.fetch}
        onClick={() => onAction('fetch')}
      />
      <ActionButton
        icon={ArrowDownToLine}
        title={translate(
          'auto.components.right.sidebar.SourceControl.submodulePull',
          'Pull {{value0}}',
          {
            value0: name
          }
        )}
        disabled={anyBusy || !enabled.pull}
        onClick={() => onAction('pull')}
      />
      <ActionButton
        icon={ArrowUp}
        title={translate(
          'auto.components.right.sidebar.SourceControl.submodulePush',
          'Push {{value0}}',
          {
            value0: name
          }
        )}
        disabled={anyBusy || !enabled.push}
        onClick={() => onAction('push')}
      />
    </div>
  )
}

/** Each initialized submodule as its own repository, with branch and remote actions. */
export function SourceControlSubmoduleReposSection({
  repos,
  busy,
  runAction
}: UseSourceControlSubmoduleReposResult): React.JSX.Element | null {
  const [collapsed, setCollapsed] = useState(false)
  if (repos.length === 0) {
    return null
  }
  return (
    <div>
      <SectionHeader
        label={translate(
          'auto.components.right.sidebar.SourceControl.submodulesSection',
          'Submodules'
        )}
        count={repos.length}
        isCollapsed={collapsed}
        onToggle={() => setCollapsed((value) => !value)}
      />
      {!collapsed &&
        repos.map((repo) => (
          <SubmoduleRepoRow
            key={repo.path}
            repo={repo}
            anyBusy={busy !== null}
            onAction={(action) => void runAction(repo.path, action)}
          />
        ))}
    </div>
  )
}
