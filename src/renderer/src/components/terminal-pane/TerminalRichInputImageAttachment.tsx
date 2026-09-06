import { createElement, useEffect, useMemo, useState } from 'react'
import { mergeAttributes, Node } from '@tiptap/core'
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { ImageOff, Loader2 } from 'lucide-react'
import { loadLocalImageSrc } from '@/components/editor/useLocalImageSrc'
import { safeReactNodeViewRenderer } from '@/components/editor/safe-react-node-view-renderer'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { translate } from '@/i18n/i18n'
import { getFileTypeIcon } from '@/lib/file-type-icons'
import { basename } from '@/lib/path'
import { cn } from '@/lib/utils'
import { isNativeChatPastedImagePath } from '@/components/native-chat/native-chat-image-paste'
import { formatNativeChatFileReference } from '@/components/native-chat/native-chat-composer-target'
import { IMAGE_FILE_MIME_TYPES } from '../../../../shared/image-file-extensions'
import { TerminalRichInputChipRemoveButton } from './TerminalRichInputChipRemoveButton'
import {
  deleteTerminalRichInputImageAt,
  deleteTerminalRichInputImageAtSelection
} from './terminal-rich-input-image-caret'
import { TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE } from './terminal-rich-input-model'
import { removeTerminalRichInputNode } from './terminal-rich-input-node-removal'
import { openDetectedFilePath } from './terminal-file-open-routing'

export const TerminalRichInputImageAttachment = Node.create({
  name: TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      id: { default: '' },
      path: { default: '' },
      previewSrc: { default: null },
      connectionId: { default: null },
      runtimeEnvironmentId: { default: null },
      worktreeId: { default: '' },
      worktreePath: { default: '' },
      clipboardToken: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-orca-rich-input-clipboard-token'),
        renderHTML: (attributes) =>
          attributes.clipboardToken
            ? { 'data-orca-rich-input-clipboard-token': attributes.clipboardToken }
            : {}
      }
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-terminal-image-attachment]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-terminal-image-attachment': '',
        'data-attachment-id': node.attrs.id,
        'data-path': node.attrs.path
      })
    ]
  },

  renderText({ node }) {
    return formatNativeChatFileReference(String(node.attrs.path ?? ''))
  },

  addNodeView() {
    return safeReactNodeViewRenderer(TerminalRichInputImageAttachmentView, { as: 'span' })
  },

  addKeyboardShortcuts() {
    return {
      Backspace: () => deleteTerminalRichInputImageAtSelection(this.editor, 'backward'),
      Delete: () => deleteTerminalRichInputImageAtSelection(this.editor, 'forward')
    }
  }
})

function TerminalRichInputImageAttachmentView({
  node,
  deleteNode,
  editor,
  getPos,
  selected
}: NodeViewProps): React.JSX.Element {
  return (
    <NodeViewWrapper
      as="span"
      data-terminal-rich-input-image-attachment=""
      contentEditable={false}
      className="m-0.5 inline-flex pr-1 align-middle"
    >
      <TerminalRichInputImageAttachmentChip
        path={String(node.attrs.path ?? '')}
        previewSrc={nullableString(node.attrs.previewSrc)}
        connectionId={nullableString(node.attrs.connectionId)}
        runtimeEnvironmentId={nullableString(node.attrs.runtimeEnvironmentId)}
        worktreeId={String(node.attrs.worktreeId ?? '')}
        worktreePath={String(node.attrs.worktreePath ?? '')}
        selected={selected}
        onOpen={() => {
          const targetPath = nullableString(node.attrs.previewSrc) ?? String(node.attrs.path ?? '')
          if (targetPath.startsWith('blob:')) {
            return
          }
          const usesTargetOwner = targetPath === String(node.attrs.path ?? '')
          openDetectedFilePath(targetPath, null, null, {
            connectionId: usesTargetOwner ? nullableString(node.attrs.connectionId) : null,
            runtimeEnvironmentId: usesTargetOwner
              ? nullableString(node.attrs.runtimeEnvironmentId)
              : null,
            worktreeId: String(node.attrs.worktreeId ?? ''),
            worktreePath: String(node.attrs.worktreePath ?? '')
          })
        }}
        onRemove={() =>
          removeTerminalRichInputNode({
            deleteNode,
            getPosition: getPos,
            deleteAtPosition: (position) => deleteTerminalRichInputImageAt(editor, position),
            focusEditor: (position) =>
              editor.commands.focus(Math.min(position, editor.state.doc.content.size))
          })
        }
      />
    </NodeViewWrapper>
  )
}

export function TerminalRichInputImageAttachmentChip({
  path,
  previewSrc,
  connectionId,
  runtimeEnvironmentId,
  worktreeId,
  worktreePath,
  selected = false,
  onOpen,
  onRemove
}: {
  path: string
  previewSrc?: string | null
  connectionId: string | null
  runtimeEnvironmentId: string | null
  worktreeId: string
  worktreePath: string
  selected?: boolean
  onOpen: () => void
  onRemove: () => void
}): React.JSX.Element {
  const label = isNativeChatPastedImagePath(path) ? 'image.png' : basename(path)
  const AttachmentIcon = getFileTypeIcon(path)
  const [previewOpen, setPreviewOpen] = useState(false)
  return (
    <span
      className={cn(
        'group relative inline-flex h-6 max-w-56 items-center rounded-md border border-border bg-muted text-xs text-foreground',
        selected && 'ring-1 ring-ring'
      )}
    >
      <HoverCard open={previewOpen} onOpenChange={setPreviewOpen} openDelay={250} closeDelay={120}>
        <HoverCardTrigger asChild>
          <button
            type="button"
            title={path}
            aria-label={translate(
              'components.terminal.richInput.openResource',
              'Open {{value0}} in Orca',
              { value0: label || path }
            )}
            onMouseDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            onClick={(event) => {
              event.stopPropagation()
              onOpen()
            }}
            className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pl-1.5 pr-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {createElement(AttachmentIcon, {
              className:
                'size-3.5 shrink-0 text-muted-foreground group-hover:opacity-0 group-focus-within:opacity-0'
            })}
            <span className="truncate font-medium">{label || path}</span>
          </button>
        </HoverCardTrigger>
        {previewOpen ? (
          <HoverCardContent
            side="top"
            align="start"
            sideOffset={8}
            className="w-auto border-border bg-popover p-2 shadow-md backdrop-blur-none dark:border-border dark:bg-popover dark:shadow-md"
          >
            <TerminalRichInputImagePreview
              path={previewSrc ?? path}
              label={label}
              connectionId={previewSrc && previewSrc !== path ? null : connectionId}
              runtimeEnvironmentId={previewSrc && previewSrc !== path ? null : runtimeEnvironmentId}
              worktreeId={worktreeId}
              worktreePath={worktreePath}
            />
          </HoverCardContent>
        ) : null}
      </HoverCard>
      <TerminalRichInputChipRemoveButton
        label={translate('components.terminal.richInput.removeResource', 'Remove {{value0}}', {
          value0: label || path
        })}
        onRemove={onRemove}
      />
    </span>
  )
}

export function TerminalRichInputImagePreview({
  path,
  label,
  connectionId,
  runtimeEnvironmentId,
  worktreeId,
  worktreePath
}: {
  path: string
  label: string
  connectionId: string | null
  runtimeEnvironmentId: string | null
  worktreeId: string
  worktreePath: string
}): React.JSX.Element {
  const runtimeContext = useMemo(
    () =>
      runtimeEnvironmentId
        ? {
            settings: { activeRuntimeEnvironmentId: runtimeEnvironmentId },
            worktreeId,
            worktreePath,
            connectionId: connectionId ?? undefined
          }
        : undefined,
    [connectionId, runtimeEnvironmentId, worktreeId, worktreePath]
  )
  const [imageSrc, setImageSrc] = useState<string | null>()
  useEffect(() => {
    let cancelled = false
    setImageSrc(undefined)
    void loadLocalImageSrc(path, path, connectionId, runtimeContext)
      .then((src) => {
        if (!cancelled) {
          setImageSrc(src)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setImageSrc(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [connectionId, path, runtimeContext])
  return (
    <div className="w-80 space-y-2">
      <div className="flex max-h-80 min-h-32 w-full items-center justify-center overflow-hidden rounded-md bg-background outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10">
        {imageSrc === undefined ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
        ) : imageSrc ? (
          <img
            src={imageSrc}
            alt=""
            onError={() => setImageSrc(null)}
            className="max-h-80 max-w-full object-contain"
          />
        ) : (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <ImageOff className="size-3.5 shrink-0" />
            {translate('components.terminal.richInput.previewUnavailable', 'Preview unavailable')}
          </div>
        )}
      </div>
      <div className="min-w-0 space-y-1 px-0.5">
        <div className="truncate text-sm font-medium text-foreground" title={label}>
          {label}
        </div>
        <div className="truncate font-mono text-xs text-muted-foreground">
          {getImageMediaType(path)}
        </div>
      </div>
    </div>
  )
}

function getImageMediaType(path: string): string {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase()
  return IMAGE_FILE_MIME_TYPES[extension] ?? 'image'
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}
