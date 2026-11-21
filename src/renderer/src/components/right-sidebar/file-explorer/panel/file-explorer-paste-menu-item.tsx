import React, { useEffect, useState } from 'react'
import { ClipboardPaste, File, Image as ImageIcon } from 'lucide-react'
import { ContextMenuItem } from '@/components/ui/context-menu'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { basename } from '@/lib/path'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import type { ClipboardPastePreview } from '../mutations/file-explorer-clipboard-import'

type PastePreview = ClipboardPastePreview | { kind: 'text'; text: string }

function ClipboardImagePreview(): React.JSX.Element {
  const t = useTranslate()
  const enabled = useAppStore((s) => s.settings?.fileExplorerPasteThumbnailEnabled !== false)
  const [src, setSrc] = useState<string>()
  useEffect(() => {
    if (!enabled) {
      return
    }
    let current = true
    void window.api.ui
      .readClipboardImageThumbnail()
      .then((thumbnail) => {
        if (current && thumbnail) {
          setSrc(thumbnail.dataUrl)
        }
      })
      .catch(() => {})
    return () => {
      current = false
    }
  }, [enabled])
  const alt = t(
    'auto.components.right.sidebar.FileExplorerPaste.clipboardImageTitle',
    'Clipboard image'
  )
  return enabled && src ? (
    <div className="space-y-2">
      <img src={src} alt={alt} className="mx-auto max-h-32 max-w-full object-contain" />
      <p className="text-center text-muted-foreground">
        {t(
          'auto.components.right.sidebar.FileExplorerPaste.clipboardThumbnailSettingHint',
          'You can disable the thumbnail in Appearance settings.'
        )}
      </p>
    </div>
  ) : (
    <span className="flex items-center gap-2">
      <ImageIcon className="size-4" />
      {alt}
    </span>
  )
}

export function FileExplorerPasteMenuItem({
  preview,
  background,
  disabled,
  onSelect
}: {
  preview: PastePreview
  background?: boolean
  disabled?: boolean
  onSelect: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const Item = background ? DropdownMenuItem : ContextMenuItem
  return (
    <HoverCard openDelay={250} closeDelay={0}>
      <HoverCardTrigger asChild>
        <Item disabled={disabled} onSelect={onSelect}>
          <ClipboardPaste />
          {t('auto.components.right.sidebar.FileExplorerPaste.paste', 'Paste')}
          <span className="ml-auto flex min-w-0 max-w-28 items-center gap-1 text-muted-foreground">
            {preview.kind === 'files' ? (
              <>
                <strong className="shrink-0 font-semibold">
                  {t('auto.components.right.sidebar.FileExplorerPaste.clipboardFile', 'file')}:
                </strong>
                <span className="truncate">{preview.label}</span>
              </>
            ) : preview.kind === 'image' ? (
              t('auto.components.right.sidebar.FileExplorerPaste.clipboardImage', 'Image')
            ) : (
              t('auto.components.right.sidebar.FileExplorerPaste.clipboardText', 'Text')
            )}
          </span>
        </Item>
      </HoverCardTrigger>
      <HoverCardContent side="left" sideOffset={16} align="start" variant="clipboard-preview">
        {preview.kind === 'image' ? (
          <ClipboardImagePreview />
        ) : preview.kind === 'text' ? (
          <div dir="auto" className="line-clamp-6 whitespace-pre-wrap wrap-anywhere">
            {preview.text.length > 500 ? `${preview.text.slice(0, 500)}…` : preview.text}
          </div>
        ) : (
          <ul className="max-h-32 overflow-y-auto scrollbar-sleek">
            {preview.paths.map((path) => (
              <li key={path} className="flex items-center gap-2">
                <File className="size-4 shrink-0" />
                <span className="wrap-anywhere">{basename(path)}</span>
              </li>
            ))}
          </ul>
        )}
      </HoverCardContent>
    </HoverCard>
  )
}
