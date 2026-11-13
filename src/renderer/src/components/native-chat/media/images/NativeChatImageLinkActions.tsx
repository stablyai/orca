import { useState } from 'react'
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
import type { useNativeChatMarkdownImageSrc } from './use-native-chat-markdown-image-src'

type MarkdownImageSource = ReturnType<typeof useNativeChatMarkdownImageSrc>

/** The preview toolbar's file or link actions for a Markdown image; null when it offers none. */
export function NativeChatImageLinkActions({
  src,
  image,
  dialogOpen,
  isHandingOff,
  onRun
}: {
  src: string
  image: Pick<MarkdownImageSource, 'imageHref' | 'target' | 'fileLinkContext'>
  dialogOpen: boolean
  isHandingOff: () => boolean
  onRun: (action: LinkAction) => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const [menuOpen, setMenuOpen] = useState(false)
  const { imageHref, target, fileLinkContext } = image
  if (!fileLinkContext || !(target || /^https?:/i.test(src))) {
    return null
  }
  const actions =
    menuOpen && imageHref ? nativeChatLinkActions(imageHref, fileLinkContext, t) : null
  const label = target
    ? t('components.native-chat.imagePreview.fileActions', 'File actions')
    : t('components.native-chat.imagePreview.linkActions', 'Link actions')
  return (
    <DropdownMenu open={menuOpen && dialogOpen} onOpenChange={setMenuOpen} modal={false}>
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
          if (isHandingOff() || !dialogOpen) {
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
