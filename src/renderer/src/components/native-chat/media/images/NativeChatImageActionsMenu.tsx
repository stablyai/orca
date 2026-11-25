import { FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import type { LinkAction } from '@/components/link-actions/link-action-request'
import { nativeChatLinkActions } from '../../links/actions/native-chat-link-target-actions'
import type { NativeChatFileLinkContext } from '../../links/actions/native-chat-file-link-context'

/** An image preview's File or Link actions; they are built only while the menu is open. */
export function NativeChatImageActionsMenu({
  href,
  fileLinkContext,
  isFile,
  open,
  onOpenChange,
  onRun,
  restoresFocus
}: {
  href: string | undefined
  fileLinkContext: NativeChatFileLinkContext | null
  isFile: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onRun: (action: LinkAction) => void
  /** False while an action hands focus elsewhere or the preview has closed. */
  restoresFocus: () => boolean
}): React.JSX.Element {
  const t = useTranslate()
  const actions =
    open && fileLinkContext && href ? nativeChatLinkActions(href, fileLinkContext, t) : null
  const label = isFile
    ? t('components.native-chat.imagePreview.fileActions', 'File actions')
    : t('components.native-chat.imagePreview.linkActions', 'Link actions')
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={label}>
              <FileText />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={(event) => {
          if (!restoresFocus()) {
            event.preventDefault()
          }
        }}
      >
        {actions
          ? [actions.primary, actions.alternate, ...(actions.secondaryActions ?? [])].map(
              (action) =>
                action ? (
                  <DropdownMenuItem key={action.label} onSelect={() => onRun(action)}>
                    {action.label}
                  </DropdownMenuItem>
                ) : null
            )
          : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
