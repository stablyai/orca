import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { Pencil } from 'lucide-react'
import { NativeChatComposer, type NativeChatComposerHandle } from './NativeChatComposer'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { QueuedMessageInlineEditor } from './use-structured-agent-session-queued-edit'
import { translate } from '@/i18n/i18n'

export type QueuedEditAttachTarget = {
  terminalTabId: string
  agent?: AgentType
  transport: NativeChatStructuredComposerTransport
}

/** A row host only; the normal composer owns input, menus, attachments and dictation. */
export function NativeChatQueuedMessageComposer({
  editor,
  sender,
  images,
  attachTo
}: {
  editor: QueuedMessageInlineEditor
  sender?: ReactNode
  images?: ReactNode
  attachTo?: QueuedEditAttachTarget
}): React.JSX.Element {
  const composer = useRef<NativeChatComposerHandle>(null)
  const row = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (editor.acquiring) {
      return
    }
    composer.current?.focus()
  }, [editor.acquiring])
  useLayoutEffect(() => {
    const element = row.current
    const list = element?.closest('ul')
    if (!element || !list) {
      return
    }
    const reveal = (): void => {
      const bounds = list.getBoundingClientRect()
      const viewportTop = bounds.top + list.clientTop
      const viewportBottom = viewportTop + list.clientHeight
      if (!list.clientHeight) {
        return
      }
      const content = element.getBoundingClientRect()
      const delta =
        content.height > list.clientHeight
          ? content.bottom - viewportBottom
          : content.top < viewportTop
            ? content.top - viewportTop
            : Math.max(0, content.bottom - viewportBottom)
      if (delta) {
        list.scrollTop += delta
      }
    }
    reveal()
    const observer = new ResizeObserver(reveal)
    observer.observe(element)
    observer.observe(list)
    return () => observer.disconnect()
  }, [])
  return (
    <div ref={row} data-queued-message-editor className="px-2.5 py-1.5">
      <div className="flex min-h-7 items-center gap-1.5 text-xs text-muted-foreground">
        <Pencil className="size-3.5" aria-hidden />
        <span>
          {translate('components.native-chat.queuedMessages.editingMessage', 'Editing message')}
        </span>
        {sender}
        {!editor.imagesCapable ? images : null}
      </div>
      {attachTo ? (
        <NativeChatComposer
          ref={composer}
          terminalTabId={attachTo.terminalTabId}
          agent={attachTo.agent ?? 'codex'}
          paneKey={editor.draftScopeKey}
          draftScopeKey={editor.draftScopeKey}
          targetPtyId={null}
          canSend={!editor.acquiring && !editor.saving}
          structuredTransport={{
            ...attachTo.transport,
            sendOut: false,
            sendBlockedReason: undefined,
            acceptsImages: editor.imagesCapable && attachTo.transport.acceptsImages !== false
          }}
          editSession={editor}
        />
      ) : null}
    </div>
  )
}
