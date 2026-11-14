import { MoreHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import type { OrchestrationCrewRow } from '../../../../shared/orchestration/orchestration-crew'
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
  const t = useTranslate()
  const menu = useCrewMenuFocus()
  return (
    <DropdownMenu modal={false} open={menu.open} onOpenChange={menu.onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          ref={menu.triggerRef}
          aria-label={t('components.orchestrationCrew.more', 'More for {{name}}', {
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
        <DropdownMenuItem
          disabled={!canMention || !row.sendAddress}
          // Let Radix dismiss the source before the composer claims focus.
          onSelect={() => queueMicrotask(mention)}
        >
          {t('components.orchestrationCrew.mentionInMessage', 'Mention in message')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={open}>
          {t('components.orchestrationCrew.openChat', 'Open its chat')}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!row.sendAddress}
          onSelect={() => {
            if (row.sendAddress) {
              void window.api.ui.writeTerminalClipboardText(row.sendAddress).then(() =>
                toast.success(
                  t('components.orchestrationCrew.copiedAddress', "Copied {{name}}'s address", {
                    name: row.label
                  })
                )
              )
            }
          }}
        >
          {t('components.orchestrationCrew.copyAddress', 'Copy address')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
