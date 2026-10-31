import { useMemo, useState, useEffect, useCallback, useRef } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription
} from '@/components/ui/sheet'
import { isImeOwnedKeyboardEvent } from '@/lib/ime-composition-keyboard-event'
import { isWebClientLocation } from '@/lib/web-client-location'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { createAttachmentTextPreviewHook } from '../../../../shared/use-attachment-text-preview'
import { ATTACHMENT_TEXT_COPY_MAX_BYTES } from '../../../../shared/attachment-text-source'
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
  const { source, display, busy, error, setError, setBusy, load, retry } = useAttachmentTextPreview(
    path,
    read
  )
  type Navigation = 'first' | 'prev' | 'next' | 'last'
  type FieldCommit = ReturnType<typeof Promise.withResolvers<NonNullable<typeof display> | null>>
  const pendingCommit = useRef<FieldCommit | null>(null)
  const [pressedNavigation, setPressedNavigation] = useState<Navigation | null>(null)
  const [settledCommit, setSettledCommit] = useState<FieldCommit | null>(null)
  useEffect(() => {
    if (settledCommit && pendingCommit.current === settledCommit) {
      pendingCommit.current = null
      settledCommit.resolve(display)
      setSettledCommit(null)
    }
  }, [settledCommit, display])
  useEffect(() => {
    setPressedNavigation(null)
    return () => {
      pendingCommit.current?.resolve(null)
      pendingCommit.current = null
    }
  }, [source])
  const [pageInput, setPageInput] = useState<{
    source: typeof source
    display: typeof display
    draft?: string
  }>({ source, display })
  if (pageInput.source !== source || pageInput.display !== display) {
    setPageInput({ source, display })
  }
  const commitPage = () => {
    const value = pageInput.draft
    setPageInput({ source, display })
    const page = Number(value)
    if (
      value !== undefined &&
      !busy &&
      !pendingCommit.current &&
      Number.isInteger(page) &&
      page >= 1 &&
      page <= source.pageCount &&
      !(display?.page === page - 1 && display.subpage === 0)
    ) {
      const commit = Promise.withResolvers<NonNullable<typeof display> | null>()
      pendingCommit.current = commit
      void load(page - 1).then(() => {
        if (pendingCommit.current === commit) {
          if (source.disposed) {
            pendingCommit.current = null
            commit.resolve(null)
          } else {
            setSettledCommit(commit)
          }
        }
      })
    }
  }
  const navigate = async (action: Navigation) => {
    const current = pendingCommit.current ? await pendingCommit.current.promise : display
    if (!current || source.disposed) {
      return
    }
    if (action === 'first' || action === 'last') {
      return load(
        action === 'first' ? 0 : source.pageCount - 1,
        action === 'first' ? 0 : Number.MAX_SAFE_INTEGER
      )
    }
    const subpage = current.subpage + (action === 'prev' ? -1 : 1)
    const withinPage = subpage >= 0 && subpage < current.subpages
    const page = withinPage ? current.page : current.page + (subpage < 0 ? -1 : 1)
    if (page < 0 || page >= source.pageCount) {
      return
    }
    return load(page, subpage < 0 ? Number.MAX_SAFE_INTEGER : withinPage ? subpage : 0)
  }
  const clearPressedNavigation = () => setPressedNavigation(null)
  const atStart = !display || (display.page === 0 && display.subpage === 0)
  const atEnd =
    !display || (display.page + 1 === source.pageCount && display.subpage + 1 === display.subpages)
  const navigationProps = (action: Navigation, disabled: boolean) => ({
    disabled: pressedNavigation === action ? false : disabled,
    onPointerDown: () => {
      if (!disabled) {
        setPressedNavigation(action)
      }
    },
    onPointerCancel: clearPressedNavigation,
    onBlur: clearPressedNavigation,
    onClick: () => {
      setPressedNavigation(null)
      void navigate(action)
    }
  })
  const name =
    text === undefined
      ? chatTextAttachmentName(
          path,
          translate('components.native-chat.composer.pastedTextLabel', 'Pasted text')
        )
      : translate('components.native-chat.composer.pastedTextLabel', 'Pasted text')
  const run = async (action: 'copy' | 'save') => {
    setBusy(true)
    setError('')
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
        <div className="scrollbar-editor min-h-0 flex-1 overflow-auto px-4" aria-busy={busy}>
          {display?.segments.map((segment, index) => (
            <div key={index} className="whitespace-pre-wrap break-all font-mono text-sm">
              {segment.replace(/\n$/, '') || '\u00a0'}
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 px-4 pb-4 text-sm">
          <Button variant="ghost" size="sm" {...navigationProps('first', busy || atStart)}>
            {translate('components.native-chat.textAttachmentPreview.first', 'First')}
          </Button>
          <Button variant="ghost" size="sm" {...navigationProps('prev', busy || atStart)}>
            {translate('auto.components.TaskPage.297a805b64', 'Previous')}
          </Button>
          <label>
            {translate('components.native-chat.textAttachmentPreview.page', 'Page')}{' '}
            <input
              aria-label={translate(
                'components.native-chat.textAttachmentPreview.attachmentPage',
                'Attachment page'
              )}
              className="w-16 rounded border bg-background px-1"
              type="number"
              min={1}
              max={source.pageCount}
              disabled={busy}
              value={pageInput.draft ?? String((display?.page ?? 0) + 1)}
              onChange={(event) => setPageInput({ source, display, draft: event.target.value })}
              onBlur={commitPage}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !isImeOwnedKeyboardEvent(event)) {
                  event.preventDefault()
                  event.currentTarget.blur()
                }
              }}
            />{' '}
            / {source.pageCount}
          </label>
          <span>
            {display
              ? translate(
                  'components.native-chat.textAttachmentPreview.section',
                  'Section {{section}}/{{sections}}',
                  { section: display.subpage + 1, sections: display.subpages }
                )
              : ''}
          </span>
          <Button variant="ghost" size="sm" {...navigationProps('next', busy || atEnd)}>
            {translate('auto.components.TaskPage.b73717af92', 'Next')}
          </Button>
          <Button variant="ghost" size="sm" {...navigationProps('last', busy || !display)}>
            {translate('components.native-chat.textAttachmentPreview.last', 'Last')}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function formatAttachmentPreviewError(message: string): string {
  switch (message) {
    case 'Unreadable attachment reply. Try again.':
      return translate(
        'components.native-chat.textAttachmentPreview.unreadableReply',
        'Unreadable attachment reply. Try again.'
      )
    case 'Attachment changed or its reply was incomplete. Close it and try again.':
      return translate(
        'components.native-chat.textAttachmentPreview.incompleteReply',
        'Attachment changed or its reply was incomplete. Close it and try again.'
      )
    case 'This file cannot be previewed as text. Save it to open it in another app.':
      return translate(
        'components.native-chat.textAttachmentPreview.notText',
        'This file cannot be previewed as text. Save it to open it in another app.'
      )
    case 'Unable to open attachment. Try again.':
      return translate(
        'components.native-chat.textAttachmentPreview.openFailed',
        'Unable to open attachment. Try again.'
      )
    case 'This host cannot open text attachments yet. Update Orca on that host, then retry.':
      return translate(
        'components.native-chat.textAttachmentPreview.hostUpdate',
        'This host cannot open text attachments yet. Update Orca on that host, then retry.'
      )
    case 'This file is too large to copy. Save it instead.':
      return translate(
        'components.native-chat.textAttachmentPreview.copyTooLarge',
        'This file is too large to copy. Save it instead.'
      )
    case 'The attachment host is unavailable. Reconnect and retry.':
      return translate(
        'components.native-chat.textAttachmentPreview.hostUnavailable',
        'The attachment host is unavailable. Reconnect and retry.'
      )
    case 'Connection changed. Close this attachment and reopen it.':
      return translate(
        'components.native-chat.textAttachmentPreview.connectionChanged',
        'Connection changed. Close this attachment and reopen it.'
      )
    case 'Unable to read this attachment on its host. Reconnect and try again. The file may have been removed or changed.':
      return translate(
        'components.native-chat.textAttachmentPreview.readFailed',
        'Unable to read this attachment on its host. Reconnect and try again. The file may have been removed or changed.'
      )
    case 'Unable to export attachment. Try again.':
      return translate(
        'components.native-chat.textAttachmentPreview.exportError',
        'Unable to export attachment. Try again.'
      )
    default:
      return message
  }
}
