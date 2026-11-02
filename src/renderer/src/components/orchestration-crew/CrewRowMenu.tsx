import { MoreHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import type { OrchestrationCrewRow } from '../../../../shared/orchestration-crew'
import { useCrewMenuFocus } from './use-crew-menu-focus'

export function CrewRowMenu({
  row,
  open,
  canMention,
  mention
}: {
  row: OrchestrationCrewRow
  open: () => void
  canMention: boolean
  mention: () => void
}) {
  const menu = useCrewMenuFocus()
  return (
    <DropdownMenu modal={false} open={menu.open} onOpenChange={menu.onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          ref={menu.triggerRef}
          aria-label={translate('components.orchestrationCrew.more', 'More for {{name}}', {
            name: row.label
          })}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        ref={menu.contentRef}
        align="end"
        onPointerDownOutside={menu.onPointerDownOutside}
        onCloseAutoFocus={menu.onCloseAutoFocus}
      >
        <DropdownMenuItem disabled={!canMention || !row.sendAddress} onSelect={mention}>
          {translate('components.orchestrationCrew.mentionInMessage', 'Mention in message')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={open}>
          {translate('components.orchestrationCrew.openChat', 'Open its chat')}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!row.sendAddress}
          onSelect={() => {
            if (row.sendAddress) {
              void window.api.ui
                .writeTerminalClipboardText(row.sendAddress)
                .then(() =>
                  toast.success(
                    translate(
                      'components.orchestrationCrew.copiedAddress',
                      "Copied {{name}}'s address",
                      { name: row.label }
                    )
                  )
                )
            }
          }}
        >
          {translate('components.orchestrationCrew.copyAddress', 'Copy address')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
