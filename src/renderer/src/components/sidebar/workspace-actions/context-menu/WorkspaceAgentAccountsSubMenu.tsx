import type { ReactNode } from 'react'
import { UserRound } from 'lucide-react'
import {
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'

export function WorkspaceAgentAccountsSubMenu({
  disabled,
  children
}: {
  disabled: boolean
  children: ReactNode
}) {
  const t = useTranslate()
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={disabled}>
        <UserRound className="size-3.5" />
        {t('workspace.account.agents', 'Agent accounts')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent scrollable>
        <DropdownMenuLabel>
          {t('workspace.codexAccount.scope', 'For new sessions in this workspace')}
        </DropdownMenuLabel>
        {children}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
