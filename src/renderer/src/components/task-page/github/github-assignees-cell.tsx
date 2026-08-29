import React, { useCallback, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Check, ChevronDown, LoaderCircle } from 'lucide-react'

import { useAppStore } from '@/store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { GitHubUserAvatar } from '@/components/github/github-user-avatar'
import { getSettingsForRepoRuntimeOwner } from '@/lib/repo-runtime-owner'
import { cn } from '@/lib/utils'
import { parseGitHubIssueOrPRLink } from '@/lib/github-links'
import { useRepoAssigneesBySlug } from '@/hooks/useGitHubSlugMetadata'
import { githubProjectHost } from '../../../../../shared/github/project-identity'
import {
  getTaskSourceRuntimeSettings,
  type TaskSourceContext
} from '../../../../../shared/task-source-context'
import type { GitHubAssignableUser } from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { Repo } from '../../../../../shared/repo-types'
import { translate } from '@/i18n/i18n'
import { GitHubAssigneeAvatar } from './github-assignee-avatars'
import type { TaskPageGitHubWorkItemMutationRunner } from './github-work-item-mutation-runner'

export function GHAssigneesCell({
  item,
  repo,
  sourceContext,
  workItemMutation
}: {
  item: GitHubWorkItem
  repo: Repo | null
  sourceContext?: TaskSourceContext | null
  workItemMutation: TaskPageGitHubWorkItemMutationRunner
}): React.JSX.Element {
  const repoOwnerSettings = useAppStore(
    useShallow((s) => getSettingsForRepoRuntimeOwner(s, repo?.id ?? null))
  )
  const sourceSettings = useMemo(
    () =>
      sourceContext?.provider === 'github'
        ? ({
            ...repoOwnerSettings,
            ...getTaskSourceRuntimeSettings(sourceContext)
          } as typeof repoOwnerSettings)
        : repoOwnerSettings,
    [repoOwnerSettings, sourceContext]
  )
  const [open, setOpen] = useState(false)
  const [pendingLogin, setPendingLogin] = useState<string | null>(null)
  const assignees = useMemo(() => item.assignees ?? [], [item.assignees])
  const parsed = useMemo(() => parseGitHubIssueOrPRLink(item.url), [item.url])
  const owner = parsed?.slug.owner ?? null
  const repoName = parsed?.slug.repo ?? null
  const seedLogins = useMemo(
    () =>
      assignees
        .map((a) => a.login)
        .sort()
        .filter(Boolean),
    [assignees]
  )
  const metadata = useRepoAssigneesBySlug(
    open ? owner : null,
    open ? repoName : null,
    seedLogins,
    sourceSettings,
    parsed?.slug.host
  )

  const toggleAssignee = useCallback(
    async (user: GitHubAssignableUser): Promise<void> => {
      if (item.type !== 'issue') {
        return
      }
      const userLoginKey = user.login.toLowerCase()
      const isOn = assignees.some((a) => a.login.toLowerCase() === userLoginKey)
      if (
        workItemMutation.isIntentPending({
          item,
          intent: { type: 'toggleAssignee', user },
          sourceContext
        })
      ) {
        return
      }
      setPendingLogin(user.login)
      try {
        await workItemMutation.run({
          item,
          intent: { type: 'toggleAssignee', user },
          sourceContext,
          errorToast: translate(
            'auto.components.TaskPage.ca63694b4c',
            'Failed to update assignees.'
          ),
          mutate: async () => {
            const updates = isOn
              ? { removeAssignees: [user.login] }
              : { addAssignees: [user.login] }
            const target = getActiveRuntimeTarget(sourceSettings)
            if (owner && repoName) {
              const args = {
                owner,
                repo: repoName,
                host: githubProjectHost(parsed?.slug.host),
                number: item.number,
                updates
              }
              const res =
                target.kind === 'environment'
                  ? await callRuntimeRpc<
                      Awaited<ReturnType<typeof window.api.gh.updateIssueBySlug>>
                    >(target, 'github.project.updateIssueBySlug', args, { timeoutMs: 30_000 })
                  : await window.api.gh.updateIssueBySlug(args)
              if (!res.ok) {
                throw new Error(res.error.message)
              }
              return res
            }
            if (repo) {
              const runtimeRepoId =
                sourceContext?.provider === 'github' ? (sourceContext.repoId ?? repo.id) : repo.id
              const res =
                target.kind === 'environment'
                  ? await callRuntimeRpc<{ ok?: boolean; error?: string }>(
                      target,
                      'github.updateIssue',
                      { repo: runtimeRepoId, number: item.number, updates },
                      { timeoutMs: 30_000 }
                    )
                  : await window.api.gh.updateIssue({
                      repoPath: repo.path,
                      repoId: repo.id,
                      sourceContext,
                      number: item.number,
                      updates
                    })
              if (res && res.ok === false) {
                throw new Error(res.error)
              }
              return res
            }
            throw new Error('No GitHub repository context available for this issue.')
          }
        })
      } finally {
        setPendingLogin(null)
      }
    },
    [
      assignees,
      item,
      owner,
      parsed?.slug.host,
      repo,
      repoName,
      sourceContext,
      sourceSettings,
      workItemMutation
    ]
  )

  const triggerContent =
    assignees.length > 0 ? (
      <>
        <div className="flex min-w-0 -space-x-1 overflow-hidden">
          {assignees.slice(0, 3).map((assignee) => (
            <GitHubAssigneeAvatar key={assignee.login} assignee={assignee} />
          ))}
        </div>
        {assignees.length > 3 ? (
          <span className="ml-1 shrink-0 text-[10px] font-medium text-muted-foreground">
            +{assignees.length - 3}
          </span>
        ) : null}
      </>
    ) : (
      <span className="text-xs text-muted-foreground/60">-</span>
    )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={
            assignees.length
              ? translate('auto.components.TaskPage.bb63046423', 'Assigned to {{value0}}', {
                  value0: assignees.map((a) => a.login).join(', ')
                })
              : translate('auto.components.TaskPage.7f94eb6395', 'Assign issue')
          }
          aria-busy={pendingLogin !== null}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          className={cn(
            'inline-flex h-6 max-w-full items-center gap-1 text-left transition disabled:opacity-60',
            assignees.length > 0
              ? 'rounded-full border border-border/40 bg-background/70 px-1.5 hover:bg-muted/60'
              : 'w-full rounded-sm border border-transparent bg-transparent px-1 hover:bg-muted/40'
          )}
        >
          {triggerContent}
          {pendingLogin ? (
            <LoaderCircle className="size-3 shrink-0 animate-spin text-muted-foreground" />
          ) : assignees.length > 0 ? (
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="popover-scroll-content scrollbar-sleek w-64 p-1"
        onClick={(event) => event.stopPropagation()}
      >
        {!owner || !repoName ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">
            {translate('auto.components.TaskPage.53e002d895', 'Issue has no repo slug.')}
          </div>
        ) : metadata.loading ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">
            {translate('auto.components.TaskPage.0eacf48491', 'Loading…')}
          </div>
        ) : metadata.error ? (
          <div className="px-2 py-2 text-xs text-destructive">{metadata.error}</div>
        ) : metadata.data.length === 0 ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">
            {translate('auto.components.TaskPage.edf4bc4135', 'No assignable users.')}
          </div>
        ) : (
          metadata.data.map((user) => {
            const isOn = assignees.some((a) => a.login.toLowerCase() === user.login.toLowerCase())
            const pending = pendingLogin === user.login
            return (
              <button
                key={user.login}
                type="button"
                disabled={pendingLogin !== null}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted/50 disabled:opacity-60"
                onClick={(event) => {
                  event.stopPropagation()
                  void toggleAssignee(user)
                }}
              >
                <span
                  className={cn(
                    'flex size-3.5 shrink-0 items-center justify-center rounded-sm border',
                    isOn ? 'border-primary bg-primary text-primary-foreground' : 'border-input'
                  )}
                >
                  {pending ? (
                    <LoaderCircle className="size-3 animate-spin" />
                  ) : isOn ? (
                    <Check className="size-3" />
                  ) : null}
                </span>
                <GitHubUserAvatar
                  login={user.login}
                  name={user.name}
                  avatarUrl={user.avatarUrl}
                  className="size-5"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{user.login}</span>
                  {user.name ? (
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {user.name}
                    </span>
                  ) : null}
                </span>
              </button>
            )
          })
        )}
      </PopoverContent>
    </Popover>
  )
}
