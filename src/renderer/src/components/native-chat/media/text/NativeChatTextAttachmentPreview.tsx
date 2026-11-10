import { useMemo, useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { createAttachmentTextPreviewHook } from '../../../../../../shared/attachment-text/use-attachment-text-preview'
import { ATTACHMENT_TEXT_COPY_MAX_BYTES } from '../../../../../../shared/attachment-text/attachment-text-source'
import { AttachmentTextScrollView } from './AttachmentTextScrollView'
import { formatAttachmentPreviewError } from './native-chat-text-attachment-error'
import { createChatAttachmentReader } from './native-chat-text-attachment-read'
import { chatTextAttachmentName } from '../../../../../../shared/native-chat-text-attachment-references'

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
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  useUiLanguageRevision()
  const read = useMemo(() => createChatAttachmentReader(target, text), [target, text])
  const { source, revision, busy, error, setError, setBusy, demand, retry } =
    useAttachmentTextPreview(path, read)
  const name =
    text === undefined
      ? chatTextAttachmentName(
          path,
          t('components.native-chat.composer.pastedTextLabel', 'Pasted text')
        )
      : t('components.native-chat.composer.pastedTextLabel', 'Pasted text')
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
          t('components.native-chat.textAttachmentPreview.copiedContents', 'Copied contents')
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
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          source.dispose()
          onClose()
        }
      }}
    >
      <DialogContent className="flex h-[88vh] max-h-[calc(100vh-2rem)] min-h-0 w-[calc(100vw-2rem)] max-w-6xl flex-col overflow-hidden sm:max-w-6xl">
        <DialogHeader className="mr-8 min-w-0 shrink-0 text-left">
          <DialogTitle>
            <span className="block truncate">{name}</span>
          </DialogTitle>
          <DialogDescription>
            <span className="block truncate">
              {source.size === null
                ? t(
                    'components.native-chat.textAttachmentPreview.textAttachment',
                    'Text attachment'
                  )
                : t('components.native-chat.textAttachmentPreview.byteSize', '{{size}} bytes', {
                    size: source.size.toLocaleString(intlLocale)
                  })}
            </span>
          </DialogDescription>
        </DialogHeader>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy || source.size === null || copyTooLarge}
            onClick={() => void run('copy')}
          >
            {t('components.native-chat.textAttachmentPreview.copyContents', 'Copy contents')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || source.size === null}
            onClick={() => void run('save')}
          >
            {t('components.native-chat.textAttachmentPreview.saveFile', 'Save file')}
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
              {t('common.cancel', 'Cancel')}
            </Button>
          ) : null}
        </div>
        {copyTooLarge ? (
          <p className="shrink-0 text-sm text-muted-foreground">
            {t(
              'components.native-chat.textAttachmentPreview.copyTooLarge',
              'This file is too large to copy. Save it instead.'
            )}
          </p>
        ) : null}
        {error ? (
          <div role="alert" className="shrink-0 text-sm">
            <p>{formatAttachmentPreviewError(error, t)}</p>
            <Button variant="outline" size="sm" disabled={busy} onClick={retry}>
              {t('common.retry', 'Retry')}
            </Button>
          </div>
        ) : null}
        <AttachmentTextScrollView source={source} revision={revision} demand={demand} />
      </DialogContent>
    </Dialog>
  )
}
