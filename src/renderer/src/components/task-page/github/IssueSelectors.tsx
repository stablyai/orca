import React, { useMemo, useCallback } from 'react'
import { translate } from '@/i18n/i18n'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { LoaderCircle, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { GitHubAssignableUser } from '../../../../../shared/github/pull-request-types'
import { GitHubAssigneeAvatar } from './Avatars'
export function GitHubIssueLabelSelector({
  labels,
  selectedLabels,
  loading,
  error,
  disabled,
  onChange
}: {
  labels: string[]
  selectedLabels: string[]
  loading: boolean
  error: string | null
  disabled: boolean
  onChange: (labels: string[]) => void
}): React.JSX.Element {
  const selectedSet = useMemo(() => new Set(selectedLabels), [selectedLabels])
  const toggleLabel = useCallback(
    (label: string) => {
      onChange(
        selectedSet.has(label)
          ? selectedLabels.filter((name) => name !== label)
          : [...selectedLabels, label]
      )
    },
    [onChange, selectedLabels, selectedSet]
  )
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label className="text-[11px] font-medium text-muted-foreground">
        {translate('auto.components.TaskPage.d0ca4aa1d0', 'Labels')}
      </label>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            className="h-auto min-h-9 justify-start gap-2 px-3 py-2 text-left"
          >
            {selectedLabels.length === 0 ? (
              <span className="text-muted-foreground">
                {translate('auto.components.TaskPage.5ebff3a0aa', 'None')}
              </span>
            ) : (
              <span className="flex min-w-0 flex-wrap gap-1.5">
                {selectedLabels.map((label) => (
                  <span
                    key={label}
                    className="rounded-full border border-border/50 bg-muted/40 px-2 py-0.5 text-[11px] font-medium"
                  >
                    {label}
                  </span>
                ))}
              </span>
            )}
            {loading ? <LoaderCircle className="ml-auto size-3.5 animate-spin" /> : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="popover-scroll-content scrollbar-sleek w-64 p-1" align="start">
          {error ? (
            <div className="px-2 py-2 text-xs text-destructive">{error}</div>
          ) : labels.length === 0 ? (
            <div className="px-2 py-2 text-xs text-muted-foreground">
              {translate('auto.components.TaskPage.b36f4bf9de', 'No labels.')}
            </div>
          ) : (
            labels.map((label) => (
              <button
                key={label}
                type="button"
                onClick={() => toggleLabel(label)}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent"
              >
                <span
                  className={cn(
                    'flex size-3.5 shrink-0 items-center justify-center rounded-sm border',
                    selectedSet.has(label)
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-input'
                  )}
                >
                  {selectedSet.has(label) ? <Check className="size-2.5" /> : null}
                </span>
                <span className="min-w-0 truncate">{label}</span>
              </button>
            ))
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}
export function GitHubIssueAssigneeSelector({
  assignees,
  selectedAssignees,
  loading,
  error,
  disabled,
  onChange
}: {
  assignees: GitHubAssignableUser[]
  selectedAssignees: GitHubAssignableUser[]
  loading: boolean
  error: string | null
  disabled: boolean
  onChange: (assignees: GitHubAssignableUser[]) => void
}): React.JSX.Element {
  const selectedLogins = useMemo(
    () => new Set(selectedAssignees.map((assignee) => assignee.login.toLowerCase())),
    [selectedAssignees]
  )
  const toggleAssignee = useCallback(
    (assignee: GitHubAssignableUser) => {
      const key = assignee.login.toLowerCase()
      onChange(
        selectedLogins.has(key)
          ? selectedAssignees.filter((current) => current.login.toLowerCase() !== key)
          : [...selectedAssignees, assignee]
      )
    },
    [onChange, selectedAssignees, selectedLogins]
  )
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label className="text-[11px] font-medium text-muted-foreground">
        {translate('auto.components.TaskPage.8aba10579d', 'Assignees')}
      </label>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            className="h-auto min-h-9 justify-start gap-2 px-3 py-2 text-left"
          >
            {selectedAssignees.length === 0 ? (
              <span className="text-muted-foreground">
                {translate('auto.components.TaskPage.42a9160321', 'Unassigned')}
              </span>
            ) : (
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="flex -space-x-1">
                  {selectedAssignees.slice(0, 3).map((assignee) => (
                    <GitHubAssigneeAvatar key={assignee.login} assignee={assignee} />
                  ))}
                </span>
                <span className="min-w-0 truncate text-xs">
                  {selectedAssignees.map((assignee) => assignee.login).join(', ')}
                </span>
              </span>
            )}
            {loading ? <LoaderCircle className="ml-auto size-3.5 animate-spin" /> : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="popover-scroll-content scrollbar-sleek w-72 p-1" align="start">
          {error ? (
            <div className="px-2 py-2 text-xs text-destructive">{error}</div>
          ) : assignees.length === 0 ? (
            <div className="px-2 py-2 text-xs text-muted-foreground">
              {translate('auto.components.TaskPage.edf4bc4135', 'No assignable users.')}
            </div>
          ) : (
            assignees.map((assignee) => {
              const selected = selectedLogins.has(assignee.login.toLowerCase())
              return (
                <button
                  key={assignee.login}
                  type="button"
                  onClick={() => toggleAssignee(assignee)}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent"
                >
                  <span
                    className={cn(
                      'flex size-3.5 shrink-0 items-center justify-center rounded-sm border',
                      selected
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-input'
                    )}
                  >
                    {selected ? <Check className="size-2.5" /> : null}
                  </span>
                  <GitHubAssigneeAvatar assignee={assignee} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{assignee.login}</span>
                    {assignee.name ? (
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {assignee.name}
                      </span>
                    ) : null}
                  </span>
                </button>
              )
            })
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}
