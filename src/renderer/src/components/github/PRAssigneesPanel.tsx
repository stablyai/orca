import React, { useCallback, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { LoaderCircle, Pencil } from 'lucide-react'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { useImmediateMutation, useRepoAssignees } from '@/hooks/useIssueMetadata'
import { useRepoAssigneesBySlug } from '@/hooks/useGitHubSlugMetadata'
import { getSettingsForRepoRuntimeOwner } from '@/lib/repo-runtime-owner'
import {
  parseOwnerRepoFromItemUrl,
  type GitHubWorkItemProjectOrigin
} from '@/components/github/github-work-item-identity'
import { runIssueUpdate } from '@/components/github/github-work-item-edit-mutations'
import { ReviewerAvatar } from '@/components/github/work-item-state-presentation'
import {
  getTaskSourceRuntimeSettings,
  type TaskSourceContext
} from '../../../../shared/task-source-context'
import type { GitHubAssignableUser } from '../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'

export function PRAssigneesPanel({
  item,
  repoPath,
  projectOrigin,
  sourceContext,
  onMutated
}: {
  item: GitHubWorkItem
  repoPath: string | null
  projectOrigin: GitHubWorkItemProjectOrigin | undefined
  sourceContext?: TaskSourceContext | null
  onMutated: () => void
}): React.JSX.Element {
  const [assigneePopoverOpen, setAssigneePopoverOpen] = useState(false)
  const [localAssignees, setLocalAssignees] = useState<GitHubAssignableUser[]>(
    () => item.assignees ?? []
  )
  const [assigneesSource, setAssigneesSource] = useState(() => ({
    itemId: item.id,
    repoId: item.repoId,
    assignees: item.assignees
  }))
  const patchWorkItem = useAppStore((s) => s.patchWorkItem)
  const patchProjectRowContent = useAppStore((s) => s.patchProjectRowContent)
  const repoOwnerSettings = useAppStore(
    useShallow((s) => getSettingsForRepoRuntimeOwner(s, item.repoId ?? null))
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
  const { isPending, run } = useImmediateMutation()

  // Why: a background refetch can change PR assignees; sync before paint so the right rail never shows a stale reviewer/assignee split.
  if (
    assigneesSource.itemId !== item.id ||
    assigneesSource.repoId !== item.repoId ||
    assigneesSource.assignees !== item.assignees
  ) {
    setAssigneesSource({ itemId: item.id, repoId: item.repoId, assignees: item.assignees })
    setLocalAssignees(item.assignees ?? [])
  }

  const patchProjectRowIfNeeded = useCallback(
    (assignees: string[]) => {
      if (!projectOrigin) {
        return
      }
      patchProjectRowContent(projectOrigin.cacheKey, projectOrigin.projectItemId, { assignees })
    },
    [patchProjectRowContent, projectOrigin]
  )
  const assigneeLogins = useMemo(() => localAssignees.map((user) => user.login), [localAssignees])
  const assigneeSlug = useMemo(() => parseOwnerRepoFromItemUrl(item.url), [item.url])
  const slugOwner = projectOrigin?.owner ?? assigneeSlug?.owner ?? null
  const slugRepo = projectOrigin?.repo ?? assigneeSlug?.repo ?? null
  const repoAssigneesBySlug = useRepoAssigneesBySlug(
    slugOwner,
    slugRepo,
    assigneeLogins,
    sourceSettings,
    projectOrigin?.host ?? assigneeSlug?.host
  )
  const repoAssigneesByPath = useRepoAssignees(repoPath, item.repoId, sourceSettings)
  const repoAssignees = slugOwner && slugRepo ? repoAssigneesBySlug : repoAssigneesByPath
  const canEditAssignees = Boolean(projectOrigin || repoPath)
  const assigneesByLogin = useMemo(
    () => new Map(repoAssignees.data.map((user) => [user.login.toLowerCase(), user])),
    [repoAssignees.data]
  )

  const handleAssigneeToggle = useCallback(
    (login: string) => {
      const lowerLogin = login.toLowerCase()
      const isAssigned = localAssignees.some((user) => user.login.toLowerCase() === lowerLogin)
      const prevAssignees = localAssignees
      const candidate = assigneesByLogin.get(lowerLogin) ?? { login, name: null, avatarUrl: '' }
      const nextAssignees = isAssigned
        ? prevAssignees.filter((user) => user.login.toLowerCase() !== lowerLogin)
        : [...prevAssignees, candidate]
      const nextLogins = nextAssignees.map((user) => user.login)
      const prevLogins = prevAssignees.map((user) => user.login)

      run('assignees', {
        mutate: () =>
          runIssueUpdate({
            repoId: item.repoId,
            repoPath,
            sourceContext,
            projectOrigin,
            number: item.number,
            updates: isAssigned ? { removeAssignees: [login] } : { addAssignees: [login] }
          }),
        onOptimistic: () => {
          setLocalAssignees(nextAssignees)
          patchWorkItem(item.id, { assignees: nextAssignees }, item.repoId, { sourceContext })
          patchProjectRowIfNeeded(nextLogins)
        },
        onRevert: () => {
          setLocalAssignees(prevAssignees)
          patchWorkItem(item.id, { assignees: prevAssignees }, item.repoId, { sourceContext })
          patchProjectRowIfNeeded(prevLogins)
        },
        onSuccess: () => {
          useAppStore.getState().recordFeatureInteraction('github-tasks')
          onMutated()
        },
        onError: (err) => toast.error(err)
      })
    },
    [
      assigneesByLogin,
      item.id,
      item.number,
      item.repoId,
      localAssignees,
      onMutated,
      patchProjectRowIfNeeded,
      patchWorkItem,
      projectOrigin,
      repoPath,
      run,
      sourceContext
    ]
  )

  const checkIcon = (
    <svg className="size-2.5" viewBox="0 0 12 12" fill="none">
      <path
        d="M2 6l3 3 5-5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )

  return (
    <section>
      <div className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        <span>{translate('auto.components.GitHubItemDialog.83ac703dda', 'Assignees')}</span>
        <Popover open={assigneePopoverOpen} onOpenChange={setAssigneePopoverOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={!canEditAssignees || isPending('assignees') || repoAssignees.loading}
              aria-label={translate(
                'auto.components.GitHubItemDialog.76adcf5fe2',
                'Edit assignees'
              )}
              className="rounded p-0.5 text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-50"
            >
              {isPending('assignees') ? (
                <LoaderCircle className="size-3 animate-spin" />
              ) : (
                <Pencil className="size-3" />
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent className="popover-scroll-content scrollbar-sleek w-60 p-1" align="end">
            {repoAssignees.error ? (
              <div className="px-2 py-3 text-center text-[12px] text-destructive">
                {repoAssignees.error}
              </div>
            ) : (
              <div>
                {repoAssignees.data.map((user) => {
                  const selected = localAssignees.some(
                    (assignee) => assignee.login.toLowerCase() === user.login.toLowerCase()
                  )
                  return (
                    <button
                      key={user.login}
                      type="button"
                      onClick={() => handleAssigneeToggle(user.login)}
                      className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-[12px] hover:bg-accent"
                    >
                      <span
                        className={cn(
                          'flex size-3.5 items-center justify-center rounded-sm border',
                          selected
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-input'
                        )}
                      >
                        {selected && checkIcon}
                      </span>
                      {user.avatarUrl ? (
                        <img src={user.avatarUrl} alt="" className="size-5 rounded-full" />
                      ) : null}
                      <span className="min-w-0 flex-1 text-left">
                        <span className="block truncate">{user.login}</span>
                        {user.name ? (
                          <span className="block truncate text-[11px] text-muted-foreground">
                            {user.name}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </PopoverContent>
        </Popover>
      </div>
      {localAssignees.length === 0 ? (
        <div className="text-[12px] text-muted-foreground">
          {translate('auto.components.GitHubItemDialog.c67de9e2fe', 'No one assigned')}
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {localAssignees.map((assignee) => (
            <li key={assignee.login} className="flex min-w-0 items-center gap-2">
              <ReviewerAvatar login={assignee.login} avatarUrl={assignee.avatarUrl} />
              <span className="min-w-0 truncate text-[13px] font-medium text-foreground">
                {assignee.login}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
