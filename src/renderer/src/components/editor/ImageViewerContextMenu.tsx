import { Copy } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { translate } from '@/i18n/i18n'

export default function ImageViewerContextMenu({
  copyImage,
  children
}: {
  copyImage: (() => void) | undefined
  children: ReactNode
}): JSX.Element {
  if (!copyImage) {
    return <>{children}</>
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={copyImage}>
          <Copy />
          {translate('components.native-chat.composer.copyImage', 'Copy image')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
