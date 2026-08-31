import React, { useCallback, useId, useMemo } from 'react'
import { Check, LoaderCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { GitHubAssignableUser } from '../../../../../shared/github/pull-request-types'
import { GitHubAssigneeAvatar } from './github-assignee-avatars'

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

  // Why: name the trigger with both nodes so the field label and current selection are announced.
  const selectorId = useId()
  const labelId = `assignees-label-${selectorId}`
  const triggerId = `assignees-trigger-${selectorId}`

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span id={labelId} className="text-[11px] font-medium text-muted-foreground">
        {translate('auto.components.TaskPage.8aba10579d', 'Assignees')}
      </span>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            id={triggerId}
            aria-labelledby={`${labelId} ${triggerId}`}
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
