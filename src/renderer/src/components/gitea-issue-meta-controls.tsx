import { useState } from 'react'
import { Check, LoaderCircle, Save, Tag, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { GiteaIssueUpdate, GiteaLabel, GiteaUser } from '../../../shared/types'
import type { GiteaIssueScope } from '@/store/slices/gitea'
import { translate } from '@/i18n/i18n'

type GiteaIssueMetaControlsProps = {
  scope: GiteaIssueScope
  issueNumber: number
  title: string
  labelNames: string[]
  assigneeLogins: string[]
  repoLabels: GiteaLabel[]
  repoAssignees: GiteaUser[]
  onChanged: () => void
}

function scopedArgs(scope: GiteaIssueScope, issueNumber: number) {
  return {
    repoPath: scope.repoPath,
    repoId: scope.repoId ?? null,
    sourceContext: scope.sourceContext ?? null,
    number: issueNumber
  }
}

export function GiteaIssueMetaControls({
  scope,
  issueNumber,
  title,
  labelNames,
  assigneeLogins,
  repoLabels,
  repoAssignees,
  onChanged
}: GiteaIssueMetaControlsProps): React.JSX.Element {
  const [titleDraft, setTitleDraft] = useState(title)
  const [pending, setPending] = useState<string | null>(null)

  const save = async (field: string, updates: GiteaIssueUpdate): Promise<void> => {
    if (pending) {
      return
    }
    setPending(field)
    try {
      const result = await window.api.gitea.updateIssue({
        ...scopedArgs(scope, issueNumber),
        updates
      })
      if (!result.ok) {
        throw new Error(result.error)
      }
      onChanged()
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate(
              'auto.components.gitea.issue.meta.controls.ba343731c0',
              'Failed to update issue.'
            )
      )
    } finally {
      setPending(null)
    }
  }

  const selectedLabelNames = new Set(labelNames)
  const selectedLogins = new Set(assigneeLogins)

  const toggleLabel = (label: GiteaLabel): void => {
    const next = new Set(selectedLabelNames)
    if (next.has(label.name)) {
      next.delete(label.name)
    } else {
      next.add(label.name)
    }
    const labelIds = repoLabels.filter((entry) => next.has(entry.name)).map((entry) => entry.id)
    void save('labels', { labelIds })
  }

  const toggleAssignee = (user: GiteaUser): void => {
    const next = new Set(selectedLogins)
    if (next.has(user.login)) {
      next.delete(user.login)
    } else {
      next.add(user.login)
    }
    void save('assignees', { assignees: [...next] })
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border/40 px-4 py-2.5">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Input
          value={titleDraft}
          onChange={(event) => setTitleDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              const next = titleDraft.trim()
              if (next && next !== title) {
                void save('title', { title: next })
              }
            }
          }}
          className="h-8 text-xs"
          aria-label={translate('auto.components.gitea.issue.meta.controls.63f46a8d86', 'Title')}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={pending === 'title' || !titleDraft.trim() || titleDraft.trim() === title}
          onClick={() => void save('title', { title: titleDraft.trim() })}
        >
          {pending === 'title' ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <Save className="size-4" />
          )}
        </Button>
      </div>

      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" disabled={pending === 'labels'} className="gap-1.5">
            {pending === 'labels' ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <Tag className="size-3.5" />
            )}
            {translate('auto.components.gitea.issue.meta.controls.8cc407607b', 'Labels')}
            {labelNames.length > 0 ? (
              <span className="text-muted-foreground">{labelNames.length}</span>
            ) : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="popover-scroll-content scrollbar-sleek w-56 p-1" align="end">
          {repoLabels.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              {translate(
                'auto.components.gitea.issue.meta.controls.11fac85e07',
                'No labels in this repo.'
              )}
            </p>
          ) : (
            repoLabels.map((label) => (
              <button
                key={label.id}
                type="button"
                onClick={() => toggleLabel(label)}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent"
              >
                <span
                  className="size-3 shrink-0 rounded-full border border-border/50"
                  style={
                    label.color
                      ? { backgroundColor: `#${label.color.replace(/^#/, '')}` }
                      : undefined
                  }
                />
                <span className="min-w-0 flex-1 truncate">{label.name}</span>
                {selectedLabelNames.has(label.name) ? (
                  <Check className="size-3.5 shrink-0" />
                ) : null}
              </button>
            ))
          )}
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            disabled={pending === 'assignees'}
            className="gap-1.5"
          >
            {pending === 'assignees' ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <UserPlus className="size-3.5" />
            )}
            {translate('auto.components.gitea.issue.meta.controls.401f7dc7a2', 'Assignees')}
            {assigneeLogins.length > 0 ? (
              <span className="text-muted-foreground">{assigneeLogins.length}</span>
            ) : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="popover-scroll-content scrollbar-sleek w-56 p-1" align="end">
          {repoAssignees.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              {translate(
                'auto.components.gitea.issue.meta.controls.3cd6f5acbd',
                'No assignable users.'
              )}
            </p>
          ) : (
            repoAssignees.map((user) => (
              <button
                key={user.id}
                type="button"
                onClick={() => toggleAssignee(user)}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent"
              >
                {user.avatarUrl ? (
                  <img src={user.avatarUrl} alt="" className="size-5 shrink-0 rounded-full" />
                ) : null}
                <span className="min-w-0 flex-1 truncate">{user.fullName || user.login}</span>
                {selectedLogins.has(user.login) ? (
                  <Check className={cn('size-3.5 shrink-0')} />
                ) : null}
              </button>
            ))
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}
