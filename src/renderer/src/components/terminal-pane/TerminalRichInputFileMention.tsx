import { createElement, useEffect, useMemo, useState, type ReactNode } from 'react'
import { mergeAttributes, Node } from '@tiptap/core'
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { Folder } from 'lucide-react'
import { safeReactNodeViewRenderer } from '@/components/editor/safe-react-node-view-renderer'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { translate } from '@/i18n/i18n'
import { getFileTypeIcon } from '@/lib/file-type-icons'
import { basename } from '@/lib/path'
import { cn } from '@/lib/utils'
import { formatNativeChatFileReference } from '../native-chat/native-chat-composer-target'
import { TerminalRichInputChipRemoveButton } from './TerminalRichInputChipRemoveButton'
import { TerminalRichInputImagePreview } from './TerminalRichInputImageAttachment'
import { isImageDropPath } from './terminal-drop-image-path'
import { TERMINAL_RICH_INPUT_FILE_MENTION_NODE } from './terminal-rich-input-model'
import { removeTerminalRichInputNode } from './terminal-rich-input-node-removal'
import {
  inspectTerminalRichInputPath,
  navigateTerminalRichInputPath,
  resolveTerminalRichInputAbsolutePath,
  type TerminalRichInputPathContext
} from './terminal-rich-input-path-navigation'

export const TerminalRichInputFileMention = Node.create({
  name: TERMINAL_RICH_INPUT_FILE_MENTION_NODE,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      path: { default: '' },
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
    return [{ tag: 'span[data-terminal-file-mention]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-terminal-file-mention': '',
        'data-path': node.attrs.path
      }),
      formatNativeChatFileReference(String(node.attrs.path ?? ''))
    ]
  },

  renderText({ node }) {
    return formatNativeChatFileReference(String(node.attrs.path ?? ''))
  },

  addNodeView() {
    return safeReactNodeViewRenderer(TerminalRichInputFileMentionView, { as: 'span' })
  }
})

function TerminalRichInputFileMentionView({
  node,
  deleteNode,
  editor,
  getPos,
  selected
}: NodeViewProps): React.JSX.Element {
  const context = useMemo<TerminalRichInputPathContext>(
    () => ({
      path: String(node.attrs.path ?? ''),
      connectionId: nullableString(node.attrs.connectionId),
      runtimeEnvironmentId: nullableString(node.attrs.runtimeEnvironmentId),
      worktreeId: String(node.attrs.worktreeId ?? ''),
      worktreePath: String(node.attrs.worktreePath ?? '')
    }),
    [
      node.attrs.path,
      node.attrs.connectionId,
      node.attrs.runtimeEnvironmentId,
      node.attrs.worktreeId,
      node.attrs.worktreePath
    ]
  )
  const absolutePath = resolveTerminalRichInputAbsolutePath(context.path, context.worktreePath)
  const [isDirectory, setIsDirectory] = useState(false)

  useEffect(() => {
    if (!absolutePath) {
      return
    }
    let cancelled = false
    void inspectTerminalRichInputPath(absolutePath, context).then((kind) => {
      if (!cancelled) {
        setIsDirectory(kind === 'directory')
      }
    })
    return () => {
      cancelled = true
    }
  }, [absolutePath, context])

  const imagePreview =
    absolutePath && isImageDropPath(absolutePath) ? (
      <TerminalRichInputImagePreview
        path={absolutePath}
        label={basename(context.path)}
        connectionId={nullableString(node.attrs.connectionId)}
        runtimeEnvironmentId={context.runtimeEnvironmentId}
        worktreeId={context.worktreeId}
        worktreePath={context.worktreePath}
      />
    ) : undefined

  return (
    <NodeViewWrapper
      as="span"
      data-terminal-rich-input-mention=""
      contentEditable={false}
      className="m-0.5 inline-flex align-middle"
    >
      <TerminalRichInputFileMentionChip
        path={context.path}
        isDirectory={isDirectory}
        preview={imagePreview}
        selected={selected}
        onOpen={() => void navigateTerminalRichInputPath(context)}
        onRemove={() =>
          removeTerminalRichInputNode({
            deleteNode,
            getPosition: getPos,
            focusEditor: (position) =>
              editor.commands.focus(Math.min(position, editor.state.doc.content.size))
          })
        }
      />
    </NodeViewWrapper>
  )
}

export function TerminalRichInputFileMentionChip({
  path,
  isDirectory,
  preview,
  selected = false,
  onOpen,
  onRemove
}: {
  path: string
  isDirectory: boolean
  preview?: ReactNode
  selected?: boolean
  onOpen: () => void
  onRemove: () => void
}): React.JSX.Element {
  const label = basename(path) || path
  const FileIcon = isDirectory ? Folder : getFileTypeIcon(path)
  const trigger = (
    <button
      type="button"
      title={path}
      aria-label={translate(
        'components.terminal.richInput.openResource',
        'Open {{value0}} in Orca',
        { value0: label }
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
      {createElement(FileIcon, {
        className:
          'size-3.5 shrink-0 text-muted-foreground group-hover:opacity-0 group-focus-within:opacity-0'
      })}
      <span className="truncate">{label}</span>
    </button>
  )

  return (
    <span
      className={cn(
        'group relative inline-flex h-6 max-w-64 items-center rounded-md border border-border bg-muted text-xs text-foreground',
        selected && 'ring-1 ring-ring'
      )}
    >
      {preview ? (
        <HoverCard openDelay={250} closeDelay={120}>
          <HoverCardTrigger asChild>{trigger}</HoverCardTrigger>
          <HoverCardContent side="top" align="start" sideOffset={8} className="w-auto p-2">
            {preview}
          </HoverCardContent>
        </HoverCard>
      ) : (
        trigger
      )}
      <TerminalRichInputChipRemoveButton
        label={translate('components.terminal.richInput.removeResource', 'Remove {{value0}}', {
          value0: label
        })}
        onRemove={onRemove}
      />
    </span>
  )
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}
