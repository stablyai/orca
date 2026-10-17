import { ChevronDown, GitBranch } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import type { GitHistoryScope } from '../../../../../../shared/git-history'

export function GitHistoryScopeMenu({
  scope,
  onChange
}: {
  scope: GitHistoryScope
  onChange: (scope: GitHistoryScope) => void
}): React.JSX.Element {
  const allLabel = translate('source-control.history.all-branches', 'All branches')
  const currentLabel = translate('source-control.history.current-branch', 'Current branch')
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          aria-label={translate('source-control.history.scope', 'History branches')}
        >
          <GitBranch className="size-3" />
          {scope === 'all' ? allLabel : currentLabel}
          <ChevronDown className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={scope}
          onValueChange={(value) => {
            if (value === 'all' || value === 'current') {
              onChange(value)
            }
          }}
        >
          <DropdownMenuRadioItem value="all">{allLabel}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="current">{currentLabel}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
