import React from 'react'
import { ChevronDown, LoaderCircle, Pencil } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { GitHubAssignableUser } from '../../../../../shared/github/pull-request-types'
import { translate } from '@/i18n/i18n'

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

export function GHEditSectionAssigneesColumn({
  localAssignees,
  repoAssignees,
  isPending,
  popoverOpen,
  onPopoverOpenChange,
  onToggle
}: {
  localAssignees: string[]
  repoAssignees: { data: GitHubAssignableUser[]; loading: boolean; error: string | null }
  isPending: boolean
  popoverOpen: boolean
  onPopoverOpenChange: (open: boolean) => void
  onToggle: (login: string) => void
}): React.JSX.Element {
  return (
    <section className="min-w-0">
      <div className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        <span>{translate('auto.components.GitHubItemDialog.83ac703dda', 'Assignees')}</span>
        <Popover open={popoverOpen} onOpenChange={onPopoverOpenChange}>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={isPending || repoAssignees.loading}
              aria-label={translate(
                'auto.components.GitHubItemDialog.76adcf5fe2',
                'Edit assignees'
              )}
              className="rounded p-0.5 text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-50"
            >
              {isPending ? (
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
                {repoAssignees.data.map((user) => (
                  <button
                    key={user.login}
                    type="button"
                    onClick={() => onToggle(user.login)}
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
                    <span className="min-w-0 flex-1 text-left">
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
      </div>
      {localAssignees.length === 0 ? (
        <div className="text-[12px] text-muted-foreground">
          {translate('auto.components.GitHubItemDialog.c67de9e2fe', 'No one assigned')}
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {localAssignees.map((login) => {
            const user = repoAssignees.data.find((u) => u.login === login)
            return (
              <li key={login} className="flex min-w-0 items-center gap-2">
                {user?.avatarUrl ? (
                  <img
                    src={user.avatarUrl}
                    alt=""
                    className="size-5 shrink-0 rounded-full border border-border/40 object-cover"
                  />
                ) : (
                  <div className="size-5 shrink-0 rounded-full bg-muted" />
                )}
                <span className="min-w-0 truncate text-[12px] font-medium text-foreground">
                  {login}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

export function GHEditSectionAssigneesPill({
  localAssignees,
  repoAssignees,
  isPending,
  popoverOpen,
  onPopoverOpenChange,
  onToggle
}: {
  localAssignees: string[]
  repoAssignees: { data: GitHubAssignableUser[]; loading: boolean; error: string | null }
  isPending: boolean
  popoverOpen: boolean
  onPopoverOpenChange: (open: boolean) => void
  onToggle: (login: string) => void
}): React.JSX.Element {
  return (
    <Popover open={popoverOpen} onOpenChange={onPopoverOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={isPending || repoAssignees.loading}
          className="group/assignees inline-flex items-center gap-1 rounded-full border border-border/30 bg-muted/20 px-2 py-0.5 text-[11px] transition hover:brightness-125 hover:ring-1 hover:ring-white/10 disabled:opacity-50"
        >
          {localAssignees.length === 0 ? (
            <span className="text-muted-foreground">
              {translate('auto.components.GitHubItemDialog.c6f37a563d', '+ Assignee')}
            </span>
          ) : (
            localAssignees.map((login) => (
              <span key={login} className="text-[10px] text-muted-foreground">
                {login}
              </span>
            ))
          )}
          {isPending ? (
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
                onClick={() => onToggle(user.login)}
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
  )
}
