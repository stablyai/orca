import { useMemo, useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription
} from '@/components/ui/sheet'
import { isWebClientLocation } from '@/lib/web-client-location'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { createAttachmentTextPreviewHook } from '../../../../shared/use-attachment-text-preview'
import { ATTACHMENT_TEXT_COPY_MAX_BYTES } from '../../../../shared/attachment-text-source'
import { AttachmentTextScrollView } from './AttachmentTextScrollView'
import { formatAttachmentPreviewError } from './native-chat-text-attachment-error'
import { createChatAttachmentReader } from './native-chat-text-attachment-read'
import { chatTextAttachmentName } from '../../../../shared/native-chat-text-attachment-references'

const useAttachmentTextPreview = createAttachmentTextPreviewHook({
  useState,
  useEffect,
  useCallback
})

export function NativeChatTextAttachmentPreview({
  path,
  text,
  target,
  onClose
}: {
  path: string
  text?: string
  target: RuntimeClientTarget | null
  onClose: () => void
}) {
  useUiLanguageRevision()
  const read = useMemo(() => createChatAttachmentReader(target, text), [target, text])
  const { source, revision, busy, error, setError, setBusy, demand, retry } =
    useAttachmentTextPreview(path, read)
  const name =
    text === undefined
      ? chatTextAttachmentName(
          path,
          translate('components.native-chat.composer.pastedTextLabel', 'Pasted text')
        )
      : translate('components.native-chat.composer.pastedTextLabel', 'Pasted text')
  const run = async (action: 'copy' | 'save') => {
    setError('')
    if (source.disposed) {
      return
    }
    setBusy(true)
    try {
      if (action === 'copy') {
        const content = await source.copyText()
        source.assertCurrent()
        await window.api.ui.writeClipboardText(content)
        source.assertCurrent()
        toast.success(
          translate(
            'components.native-chat.textAttachmentPreview.copiedContents',
            'Copied contents'
          )
        )
      } else if (isWebClientLocation()) {
        const chunks: Uint8Array<ArrayBuffer>[] = []
        for await (const bytes of source.bytes()) {
          chunks.push(new Uint8Array(bytes))
        }
        source.assertCurrent()
        const url = URL.createObjectURL(new Blob(chunks))
        try {
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = path.split(/[\\/]/).at(-1) || 'attachment.txt'
          source.assertCurrent()
          anchor.click()
        } finally {
          setTimeout(() => URL.revokeObjectURL(url), 30_000)
        }
      } else {
        const output = await window.api.fs.startDownloadedFile({
          suggestedName: path.split(/[\\/]/).at(-1) || 'attachment.txt'
        })
        if (output.canceled) {
          return
        }
        let finished = false
        try {
          for await (const bytes of source.bytes()) {
            source.assertCurrent()
            if (!bytes.length) {
              continue
            }
            await window.api.fs.appendDownloadedFileChunk({
              transferId: output.transferId,
              contentBase64: btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
            })
          }
          source.assertCurrent()
          await window.api.fs.finishDownloadedFile({ transferId: output.transferId })
          finished = true
        } finally {
          if (!finished) {
            await window.api.fs
              .cancelDownloadedFile({ transferId: output.transferId })
              .catch(() => {})
          }
        }
      }
    } catch (cause) {
      if (!source.disposed) {
        setError(cause instanceof Error ? cause.message : 'Unable to export attachment. Try again.')
      }
    } finally {
      if (!source.disposed) {
        setBusy(false)
      }
    }
  }

  const copyTooLarge = (source.size ?? 0) > ATTACHMENT_TEXT_COPY_MAX_BYTES
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) {
          source.dispose()
          onClose()
        }
      }}
    >
      <SheetContent className="flex w-full flex-col sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{name}</SheetTitle>
          <SheetDescription className="break-all">
            {source.size === null
              ? translate(
                  'components.native-chat.textAttachmentPreview.textAttachment',
                  'Text attachment'
                )
              : translate(
                  'components.native-chat.textAttachmentPreview.byteSize',
                  '{{size}} bytes',
                  { size: source.size.toLocaleString(getIntlLocale()) }
                )}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-wrap gap-2 px-4">
          <Button
            variant="outline"
            size="sm"
            disabled={busy || source.size === null || copyTooLarge}
            onClick={() => void run('copy')}
          >
            {translate(
              'components.native-chat.textAttachmentPreview.copyContents',
              'Copy contents'
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || source.size === null}
            onClick={() => void run('save')}
          >
            {translate('components.native-chat.textAttachmentPreview.saveFile', 'Save file')}
          </Button>
          {busy ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                source.dispose()
                onClose()
              }}
            >
              {translate('common.cancel', 'Cancel')}
            </Button>
          ) : null}
        </div>
        {copyTooLarge ? (
          <p className="px-4 text-sm text-muted-foreground">
            {translate(
              'components.native-chat.textAttachmentPreview.copyTooLarge',
              'This file is too large to copy. Save it instead.'
            )}
          </p>
        ) : null}
        {error ? (
          <div role="alert" className="px-4 text-sm">
            <p>{formatAttachmentPreviewError(error)}</p>
            <Button variant="outline" size="sm" disabled={busy} onClick={retry}>
              {translate('common.retry', 'Retry')}
            </Button>
          </div>
        ) : null}
        <AttachmentTextScrollView source={source} revision={revision} demand={demand} />
      </SheetContent>
    </Sheet>
  )
}
