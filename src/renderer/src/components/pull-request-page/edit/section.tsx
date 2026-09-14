import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ArrowRight, ChevronDown, CircleDashed, CircleDot, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { useImmediateMutation, useRepoAssignees, useRepoLabels } from '@/hooks/useIssueMetadata'
import { useRepoAssigneesBySlug, useRepoLabelsBySlug } from '@/hooks/useGitHubSlugMetadata'
import { getTaskSourceRuntimeSettings } from '../../../../../shared/task-source-context'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import { getSettingsForRepoRuntimeOwner } from '@/lib/repo-runtime-owner'
import { getStateLabel } from '@/components/github/work-item-state-presentation'
import { translate } from '@/i18n/i18n'
import type { PullRequestPageProjectOrigin } from '../page-types'
import { getStateTone } from '../presentation/state-badge'
import { changeIssueState, toggleIssueAssignee, toggleIssueLabel } from './issue-updates'

export function GHEditSection({
  item,
  repoPath,
  repoId,
  sourceContext,
  projectOrigin,
  localState,
  localLabels,
  onStateChange,
  onLabelsChange,
  onMutated,
  assignees,
  onUse
}: {
  item: GitHubWorkItem
  repoPath: string | null
  repoId: string | null
  sourceContext?: TaskSourceContext | null
  projectOrigin: PullRequestPageProjectOrigin | undefined
  localState: GitHubWorkItem['state']
  localLabels: string[]
  onStateChange: (state: GitHubWorkItem['state']) => void
  onLabelsChange: (labels: string[]) => void
  /** Called after a successful issue mutation so the parent can invalidate its details cache; otherwise a reopen within FRESH_MS paints pre-mutation data. */
  onMutated: () => void
  assignees: string[]
  onUse: (item: GitHubWorkItem) => void
}): React.JSX.Element | null {
  const [labelPopoverOpen, setLabelPopoverOpen] = useState(false)
  const [assigneePopoverOpen, setAssigneePopoverOpen] = useState(false)
  const [localAssignees, setLocalAssignees] = useState<string[]>(assignees)
  const editedAssigneesItemKeyRef = useRef<string | null>(null)
  const assigneesItemKey = `${item.repoId}\0${item.id}`
  const patchWorkItem = useAppStore((s) => s.patchWorkItem)
  const patchProjectRowContent = useAppStore((s) => s.patchProjectRowContent)
  const repoOwnerSettings = useAppStore(
    useShallow((s) => getSettingsForRepoRuntimeOwner(s, item.repoId ?? repoId ?? null))
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
  // Why: patchWorkItem only updates workItemsCache; Project-view rows also need projectViewCache patched or the table stays stale. See docs/design/github-project-view-tasks.md.
  const patchProjectRowIfNeeded = useCallback(
    (patch: Parameters<typeof patchProjectRowContent>[2]) => {
      if (!projectOrigin) {
        return
      }
      patchProjectRowContent(projectOrigin.cacheKey, projectOrigin.projectItemId, patch)
    },
    [projectOrigin, patchProjectRowContent]
  )

  // Why: with projectOrigin set, read labels/assignees from the row's repo (not workspace path) so popovers match where writes target.
  const slugOwner = projectOrigin?.owner ?? null
  const slugRepo = projectOrigin?.repo ?? null
  const repoLabelsByPath = useRepoLabels(
    projectOrigin ? null : repoPath,
    projectOrigin ? null : repoId,
    sourceSettings
  )
  const repoLabelsBySlug = useRepoLabelsBySlug(
    slugOwner,
    slugRepo,
    sourceSettings,
    projectOrigin?.host
  )
  const repoLabels = projectOrigin ? repoLabelsBySlug : repoLabelsByPath
  const repoAssigneesByPath = useRepoAssignees(
    projectOrigin ? null : repoPath,
    projectOrigin ? null : repoId,
    sourceSettings
  )
  const repoAssigneesBySlug = useRepoAssigneesBySlug(
    slugOwner,
    slugRepo,
    assignees,
    sourceSettings,
    projectOrigin?.host
  )
  const repoAssignees = projectOrigin ? repoAssigneesBySlug : repoAssigneesByPath

  // Why: sync local assignees on item change / detail resolve, but skip if the user made an optimistic edit so we don't clobber in-flight changes.
  useEffect(() => {
    if (editedAssigneesItemKeyRef.current === assigneesItemKey) {
      return
    }
    setLocalAssignees(assignees)
  }, [assigneesItemKey, assignees])

  if (item.type === 'pr') {
    return null
  }

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
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/60 px-4 py-2.5">
      {/* State */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              'group/status inline-flex items-center gap-0.5 rounded-full border px-2 py-0.5 text-[11px] font-medium transition hover:brightness-125 hover:ring-1 hover:ring-white/10',
              getStateTone({ ...item, state: localState })
            )}
          >
            {getStateLabel({ ...item, state: localState })}
            <ChevronDown className="size-2.5 opacity-50" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-36 p-1" align="start">
          <button
            type="button"
            onClick={() =>
              changeIssueState({
                newState: 'open',
                localState,
                item,
                repoPath,
                sourceContext,
                projectOrigin,
                run,
                onStateChange,
                patchWorkItem,
                patchProjectRowIfNeeded,
                onMutated
              })
            }
            className={cn(
              'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-[12px] hover:bg-accent',
              localState === 'open' && 'bg-accent/50'
            )}
          >
            <CircleDot className="size-3 text-emerald-500" />
            {translate('auto.components.PullRequestPage.7b8f6bf6d8', 'Open')}
          </button>
          <button
            type="button"
            onClick={() =>
              changeIssueState({
                newState: 'closed',
                localState,
                item,
                repoPath,
                sourceContext,
                projectOrigin,
                run,
                onStateChange,
                patchWorkItem,
                patchProjectRowIfNeeded,
                onMutated
              })
            }
            className={cn(
              'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-[12px] hover:bg-accent',
              localState === 'closed' && 'bg-accent/50'
            )}
          >
            <CircleDashed className="size-3 text-rose-500" />
            {translate('auto.components.PullRequestPage.b936cc51a4', 'Closed')}
          </button>
        </PopoverContent>
      </Popover>

      {/* Labels */}
      <Popover open={labelPopoverOpen} onOpenChange={setLabelPopoverOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={isPending('labels') || repoLabels.loading}
            className="group/labels inline-flex items-center gap-1 rounded-full border border-border/30 bg-muted/20 px-2 py-0.5 text-[11px] transition hover:brightness-125 hover:ring-1 hover:ring-white/10 disabled:opacity-50"
          >
            {localLabels.length === 0 ? (
              <span className="text-muted-foreground">
                {translate('auto.components.PullRequestPage.bc215fea4d', '+ Label')}
              </span>
            ) : (
              localLabels.map((name) => (
                <span key={name} className="text-[10px] text-muted-foreground">
                  {name}
                </span>
              ))
            )}
            {isPending('labels') ? (
              <LoaderCircle className="size-3 animate-spin text-muted-foreground" />
            ) : (
              <ChevronDown className="size-2.5 opacity-50" />
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent className="popover-scroll-content scrollbar-sleek w-52 p-1" align="start">
          {repoLabels.error ? (
            <div className="px-2 py-3 text-center text-[12px] text-destructive">
              {repoLabels.error}
            </div>
          ) : (
            <div>
              {repoLabels.data.map((label) => (
                <button
                  key={label}
                  type="button"
                  onClick={() =>
                    toggleIssueLabel({
                      label,
                      localLabels,
                      item,
                      repoPath,
                      sourceContext,
                      projectOrigin,
                      run,
                      onLabelsChange,
                      patchWorkItem,
                      patchProjectRowIfNeeded,
                      onMutated
                    })
                  }
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-[12px] hover:bg-accent"
                >
                  <span
                    className={cn(
                      'flex size-3.5 items-center justify-center rounded-sm border',
                      localLabels.includes(label)
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-input'
                    )}
                  >
                    {localLabels.includes(label) && checkIcon}
                  </span>
                  {label}
                </button>
              ))}
            </div>
          )}
        </PopoverContent>
      </Popover>

      {/* Assignees */}
      <Popover open={assigneePopoverOpen} onOpenChange={setAssigneePopoverOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={isPending('assignees') || repoAssignees.loading}
            className="group/assignees inline-flex items-center gap-1 rounded-full border border-border/30 bg-muted/20 px-2 py-0.5 text-[11px] transition hover:brightness-125 hover:ring-1 hover:ring-white/10 disabled:opacity-50"
          >
            {localAssignees.length === 0 ? (
              <span className="text-muted-foreground">
                {translate('auto.components.PullRequestPage.14c9fc70ed', '+ Assignee')}
              </span>
            ) : (
              localAssignees.map((login) => (
                <span key={login} className="text-[10px] text-muted-foreground">
                  {login}
                </span>
              ))
            )}
            {isPending('assignees') ? (
              <LoaderCircle className="size-3 animate-spin text-muted-foreground" />
            ) : (
              <ChevronDown className="size-2.5 opacity-50" />
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent className="popover-scroll-content scrollbar-sleek w-52 p-1" align="start">
          {repoAssignees.error ? (
            <div className="px-2 py-3 text-center text-[12px] text-destructive">
              {repoAssignees.error}
            </div>
          ) : (
            <div>
              {repoAssignees.data.map((user) => (
                <button
                  key={user.login}
                  type="button"
                  onClick={() =>
                    toggleIssueAssignee({
                      login: user.login,
                      localAssignees,
                      assigneesItemKey,
                      editedAssigneesItemKeyRef,
                      item,
                      repoPath,
                      sourceContext,
                      projectOrigin,
                      run,
                      setLocalAssignees,
                      patchProjectRowIfNeeded,
                      onMutated
                    })
                  }
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-[12px] hover:bg-accent"
                >
                  <span
                    className={cn(
                      'flex size-3.5 items-center justify-center rounded-sm border',
                      localAssignees.includes(user.login)
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-input'
                    )}
                  >
                    {localAssignees.includes(user.login) && checkIcon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{user.login}</span>
                    {user.name && (
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {user.name}
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}
        </PopoverContent>
      </Popover>

      <Button
        size="sm"
        onClick={() => onUse(item)}
        className="ml-auto gap-2"
        aria-label={translate(
          'auto.components.PullRequestPage.61452f2143',
          'Start workspace from issue'
        )}
      >
        {translate('auto.components.PullRequestPage.61452f2143', 'Start workspace from issue')}
        <ArrowRight className="size-4" />
      </Button>
    </div>
  )
}
