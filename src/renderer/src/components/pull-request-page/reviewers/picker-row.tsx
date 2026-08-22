import React from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { GitHubAssignableUser } from '../../../../../shared/github/pull-request-types'

export function ReviewerPickerRow({
  id,
  reviewer,
  suggested,
  active,
  selected,
  activeIndex,
  disabled,
  onHover,
  onRequest
}: {
  id: string
  reviewer: GitHubAssignableUser
  suggested: boolean
  active: boolean
  selected: boolean
  activeIndex: number
  disabled: boolean
  onHover: (index: number) => void
  onRequest: (reviewer: GitHubAssignableUser) => void
}): React.JSX.Element {
  return (
    <button
      id={id}
      type="button"
      disabled={disabled}
      aria-label={
        selected
          ? translate(
              'auto.components.PullRequestPage.36b514a457',
              'Unrequest reviewer {{value0}}',
              { value0: reviewer.login }
            )
          : translate('auto.components.PullRequestPage.41d275d3ec', 'Request reviewer {{value0}}', {
              value0: reviewer.login
            })
      }
      aria-pressed={selected}
      className={cn(
        'flex min-h-10 w-full items-center gap-2 border-b border-border/70 px-3 py-2 text-left text-[13px] outline-none last:border-b-0 hover:bg-accent/70 focus-visible:bg-accent focus-visible:text-accent-foreground disabled:pointer-events-none disabled:opacity-50',
        active && 'bg-accent text-accent-foreground',
        selected && 'font-medium'
      )}
      onMouseEnter={() => onHover(activeIndex)}
      onMouseDown={(event) => {
        event.preventDefault()
      }}
      onFocus={() => onHover(activeIndex)}
      onClick={() => {
        onRequest(reviewer)
      }}
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-foreground">
        {selected ? <Check className="size-3.5" /> : null}
      </span>
      {reviewer.avatarUrl ? (
        <img src={reviewer.avatarUrl} alt="" className="size-5 shrink-0 rounded-full" />
      ) : (
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
          {reviewer.login.slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate">
          <span className="font-semibold text-foreground">{reviewer.login}</span>
          {reviewer.name ? (
            <span className="ml-1 font-normal text-muted-foreground">{reviewer.name}</span>
          ) : null}
        </span>
        {suggested ? (
          <span className="block truncate text-[12px] leading-4 text-muted-foreground">
            {translate('auto.components.PullRequestPage.f4a4b3fd9f', 'Recently edited these files')}
          </span>
        ) : null}
      </span>
    </button>
  )
}
