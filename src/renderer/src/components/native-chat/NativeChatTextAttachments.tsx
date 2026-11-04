import { translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { createContext, useCallback, useContext, useState, useMemo, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import {
  nativeChatTextAttachmentPaths,
  chatTextAttachmentName
} from '../../../../shared/native-chat-text-attachment-references'
import { NativeChatTextAttachmentPreview } from './NativeChatTextAttachmentPreview'
import { NativeChatMarkdownImageOwnerContext } from './native-chat-markdown-image-owner'

export const NativeChatTextAttachmentOpener = createContext<
  ((path: string, text?: string) => void) | null
>(null)

export function NativeChatTextAttachmentScope({
  enabled,
  children
}: {
  enabled: boolean
  children: ReactNode
}) {
  return enabled ? (
    <StructuredAttachmentScope>{children}</StructuredAttachmentScope>
  ) : (
    <>{children}</>
  )
}

function StructuredAttachmentScope({ children }: { children: ReactNode }) {
  const imageOwner = useContext(NativeChatMarkdownImageOwnerContext)
  const context = imageOwner?.runtimeContext ?? null
  const visible = imageOwner?.isVisible ?? true
  const owner = JSON.stringify(context)
  const [selection, setSelection] = useState<{
    owner: string
    path: string
    text?: string
  } | null>(null)
  // Only the preview retires when its chat hides or changes owner; the editor stays mounted.
  if (selection && (selection.owner !== owner || !visible)) {
    setSelection(null)
  }
  const selected = visible && selection?.owner === owner ? selection : null
  const open = useCallback(
    (path: string, text?: string) => {
      if (visible) {
        setSelection({ owner, path, text })
      }
    },
    [owner, visible]
  )
  return (
    <NativeChatTextAttachmentOpener.Provider value={open}>
      {children}
      {selected ? (
        <NativeChatTextAttachmentPreview
          key={JSON.stringify([selected.path, context])}
          {...selected}
          target={context?.target ?? null}
          onClose={() => setSelection(null)}
        />
      ) : null}
    </NativeChatTextAttachmentOpener.Provider>
  )
}

function AttachmentButton({
  path,
  runtimeContext
}: {
  path: string
  runtimeContext?: RuntimeFileOperationArgs | null
}) {
  useUiLanguageRevision()
  const [open, setOpen] = useState(false)
  const opener = useContext(NativeChatTextAttachmentOpener)
  const visible = useContext(NativeChatMarkdownImageOwnerContext)?.isVisible ?? true
  if (open && !visible) {
    setOpen(false)
  }
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => visible && (opener ? opener(path) : setOpen(true))}
      >
        {chatTextAttachmentName(
          path,
          translate('components.native-chat.composer.pastedTextLabel', 'Pasted text')
        )}
      </Button>
      {open && visible ? (
        <NativeChatTextAttachmentPreview
          path={path}
          target={runtimeContext?.target ?? null}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}

export function NativeChatTextAttachments({
  content,
  structured,
  runtimeContext,
  renderText
}: {
  content: string
  structured: boolean
  runtimeContext?: RuntimeFileOperationArgs | null
  renderText: (text: string) => ReactNode
}) {
  const paths = useMemo(
    () => (structured ? nativeChatTextAttachmentPaths(content) : []),
    [content, structured]
  )
  return (
    <>
      {renderText(content)}
      {paths.map((path) => (
        <AttachmentButton
          key={JSON.stringify([path, runtimeContext])}
          path={path}
          runtimeContext={runtimeContext}
        />
      ))}
    </>
  )
}
