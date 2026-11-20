// The first lines of a chat-attachment store file, read from its host with chat's attachment reader:
// shown above a file link's actions. HTML shows its title and first words; binary files show nothing.
import { useEffect, useMemo, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { attachmentTextChunkSchema } from '../../../../../../shared/attachment-text/attachment-text-source'
import { hasBinaryFileExtension } from '../../../../../../shared/file-preview/binary-file-extensions'
import { isChatAttachmentStorePath } from '../../../../../../shared/native-chat/attachments/native-chat-text-attachment-references'
import { createChatAttachmentReader } from './native-chat-text-attachment-read'

const PEEK_BYTES = 4096
const PEEK_LINES = 8

/** Whether `path` gets a peek: a text-like file in a chat attachment store. */
export function isNativeChatAttachmentPeekable(path: string): boolean {
  return isChatAttachmentStorePath(path) && !hasBinaryFileExtension(path)
}

export function nativeChatAttachmentPeekText(path: string, head: string): string {
  if (!/\.html?$/i.test(path)) {
    return head.split(/\r?\n/).slice(0, PEEK_LINES).join('\n').trimEnd()
  }
  const title = /<title[^>]*>([^<]*)/i.exec(head)?.[1]?.trim()
  const words = head
    .replace(/<(script|style|head)\b[\s\S]*?(<\/\1>|$)/gi, ' ')
    .replace(/<[^>]*>?/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280)
  return [title, words].filter(Boolean).join('\n')
}

export function NativeChatAttachmentPeek({
  path,
  target
}: {
  path: string
  target: RuntimeClientTarget | null
}): React.JSX.Element | null {
  const t = useTranslate()
  const read = useMemo(() => createChatAttachmentReader(target), [target])
  const [peek, setPeek] = useState<{ path: string; text: string | null } | null>(null)
  useEffect(() => {
    const abort = new AbortController()
    read({ path, offset: 0, length: PEEK_BYTES }, abort.signal).then(
      (result) => {
        const chunk = attachmentTextChunkSchema.parse(result)
        const bytes = Uint8Array.from(atob(chunk.contentBase64), (char) => char.charCodeAt(0))
        const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
        setPeek({ path, text: nativeChatAttachmentPeekText(path, head) })
      },
      () => !abort.signal.aborted && setPeek({ path, text: null })
    )
    return () => abort.abort()
  }, [path, read])
  const shown = peek?.path === path ? peek : null
  return (
    <div
      className="mb-1 max-h-36 overflow-hidden rounded-sm border-b border-border bg-muted/40 px-1.5 py-1 font-mono text-2xs leading-4 whitespace-pre-wrap break-words text-muted-foreground"
      data-link-action-preview=""
    >
      {!shown
        ? t('components.native-chat.attachmentPeek.loading', 'Loading preview…')
        : shown.text === null
          ? t('components.native-chat.attachmentPeek.unavailable', "Couldn't read a preview.")
          : shown.text || t('components.native-chat.attachmentPeek.empty', 'Empty file')}
    </div>
  )
}
