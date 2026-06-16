import { Check, ChevronDown } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { CLOSE_ISSUE_REASONS } from './github-issue-close-reasons'
import type { GitHubIssueCloseReason } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'

export function CloseReasonDropdown({
  closeReason,
  disabled,
  onCloseReasonChange
}: {
  closeReason: GitHubIssueCloseReason
  disabled: boolean
  onCloseReasonChange: (reason: GitHubIssueCloseReason) => void
}): React.JSX.Element {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="px-2"
          disabled={disabled}
          aria-label={translate(
            'auto.components.github.CloseReasonDropdown.e1f2a3b4c5',
            'Choose close reason'
          )}
        >
          <ChevronDown className="size-3.5 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        {CLOSE_ISSUE_REASONS.map((option) => (
          <DropdownMenuItem key={option.reason} onSelect={() => onCloseReasonChange(option.reason)}>
            <div className="flex min-w-0 items-start gap-2">
              {closeReason === option.reason ? (
                <Check className="mt-0.5 size-4 shrink-0" />
              ) : (
                <span className="size-4 shrink-0" />
              )}
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[13px] font-medium">
                  {option.icon}
                  <span>{option.label}</span>
                </div>
                <p className="mt-0.5 text-[11px] text-muted-foreground">{option.description}</p>
              </div>
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
