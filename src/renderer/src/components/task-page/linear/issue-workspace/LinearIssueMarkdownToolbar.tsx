import React, { useCallback } from 'react'
import { useEditorState, type Editor } from '@tiptap/react'
import { useTranslation } from 'react-i18next'
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  ListTodo,
  Pilcrow,
  Quote,
  Strikethrough
} from 'lucide-react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'

type LinearIssueMarkdownToolbarButtonProps = {
  active?: boolean
  disabled?: boolean
  label: string
  onClick: () => void
  children: React.ReactNode
}

function LinearIssueMarkdownToolbarButton({
  active = false,
  disabled = false,
  label,
  onClick,
  children
}: LinearIssueMarkdownToolbarButtonProps): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          disabled={disabled}
          className={cn('linear-issue-markdown-toolbar-button', active && 'is-active')}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onClick}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

function LinearIssueMarkdownToolbarSeparator(): React.JSX.Element {
  return <div className="linear-issue-markdown-toolbar-separator" />
}

function applyLinearIssueLink(editor: Editor | null): void {
  if (!editor) {
    return
  }
  if (editor.isActive('link')) {
    editor.chain().focus().unsetLink().run()
    return
  }

  const previousHref = editor.getAttributes('link').href as string | undefined
  const href = window.prompt(
    translate('auto.components.LinearIssueMarkdownDescriptionEditor.5c16ec8f14', 'Link URL'),
    previousHref ?? ''
  )
  if (href === null) {
    editor.chain().focus().run()
    return
  }

  const trimmed = href.trim()
  if (!trimmed) {
    editor.chain().focus().unsetLink().run()
    return
  }

  editor.chain().focus().extendMarkRange('link').setLink({ href: trimmed }).run()
}

type ActiveFormat =
  | 'heading1'
  | 'heading2'
  | 'bold'
  | 'italic'
  | 'strike'
  | 'code'
  | 'bulletList'
  | 'orderedList'
  | 'taskList'
  | 'blockquote'
  | 'link'

function readActiveFormats(editor: Editor | null): Record<ActiveFormat, boolean> {
  return {
    heading1: editor?.isActive('heading', { level: 1 }) ?? false,
    heading2: editor?.isActive('heading', { level: 2 }) ?? false,
    bold: editor?.isActive('bold') ?? false,
    italic: editor?.isActive('italic') ?? false,
    strike: editor?.isActive('strike') ?? false,
    code: editor?.isActive('code') ?? false,
    bulletList: editor?.isActive('bulletList') ?? false,
    orderedList: editor?.isActive('orderedList') ?? false,
    taskList: editor?.isActive('taskList') ?? false,
    blockquote: editor?.isActive('blockquote') ?? false,
    link: editor?.isActive('link') ?? false
  }
}

export function LinearIssueMarkdownToolbar({
  editor,
  disabled
}: {
  editor: Editor | null
  disabled: boolean
}): React.JSX.Element {
  const t = useTranslate()
  // Why: this toolbar can outlive editor recreation, so subscribe directly to language changes.
  useTranslation()
  const runCommand = useCallback(
    (command: (editor: Editor) => void) => {
      if (!editor || disabled) {
        return
      }
      command(editor)
    },
    [disabled, editor]
  )
  // Why: the editor mutates in place and useEditor skips per-transaction renders, so subscribe;
  // the selector closes over `editor` so a new editor recomputes before its first transaction.
  const active =
    useEditorState({ editor, selector: () => readActiveFormats(editor) }) ?? readActiveFormats(null)

  return (
    <div
      className="linear-issue-markdown-toolbar"
      aria-label={t(
        'auto.components.LinearIssueMarkdownDescriptionEditor.7c52151156',
        'Issue description formatting'
      )}
    >
      <LinearIssueMarkdownToolbarButton
        label={t('auto.components.LinearIssueMarkdownDescriptionEditor.68a41d5665', 'Body text')}
        disabled={disabled}
        onClick={() => runCommand((nextEditor) => nextEditor.chain().focus().setParagraph().run())}
      >
        <Pilcrow className="size-3.5" />
      </LinearIssueMarkdownToolbarButton>
      <LinearIssueMarkdownToolbarButton
        label={t('auto.components.LinearIssueMarkdownDescriptionEditor.e3f741d258', 'Heading 1')}
        active={active.heading1}
        disabled={disabled}
        onClick={() =>
          runCommand((nextEditor) => nextEditor.chain().focus().toggleHeading({ level: 1 }).run())
        }
      >
        <Heading1 className="size-3.5" />
      </LinearIssueMarkdownToolbarButton>
      <LinearIssueMarkdownToolbarButton
        label={t('auto.components.LinearIssueMarkdownDescriptionEditor.dddaa7a0a6', 'Heading 2')}
        active={active.heading2}
        disabled={disabled}
        onClick={() =>
          runCommand((nextEditor) => nextEditor.chain().focus().toggleHeading({ level: 2 }).run())
        }
      >
        <Heading2 className="size-3.5" />
      </LinearIssueMarkdownToolbarButton>
      <LinearIssueMarkdownToolbarSeparator />
      <LinearIssueMarkdownToolbarButton
        label={t('auto.components.LinearIssueMarkdownDescriptionEditor.caa88f50d0', 'Bold')}
        active={active.bold}
        disabled={disabled}
        onClick={() => runCommand((nextEditor) => nextEditor.chain().focus().toggleBold().run())}
      >
        <Bold className="size-3.5" />
      </LinearIssueMarkdownToolbarButton>
      <LinearIssueMarkdownToolbarButton
        label={t('auto.components.LinearIssueMarkdownDescriptionEditor.5666b4493d', 'Italic')}
        active={active.italic}
        disabled={disabled}
        onClick={() => runCommand((nextEditor) => nextEditor.chain().focus().toggleItalic().run())}
      >
        <Italic className="size-3.5" />
      </LinearIssueMarkdownToolbarButton>
      <LinearIssueMarkdownToolbarButton
        label={t('auto.components.LinearIssueMarkdownDescriptionEditor.28fd951b83', 'Strike')}
        active={active.strike}
        disabled={disabled}
        onClick={() => runCommand((nextEditor) => nextEditor.chain().focus().toggleStrike().run())}
      >
        <Strikethrough className="size-3.5" />
      </LinearIssueMarkdownToolbarButton>
      <LinearIssueMarkdownToolbarButton
        label={t('auto.components.LinearIssueMarkdownDescriptionEditor.ad1869bd54', 'Inline code')}
        active={active.code}
        disabled={disabled}
        onClick={() => runCommand((nextEditor) => nextEditor.chain().focus().toggleCode().run())}
      >
        <Code className="size-3.5" />
      </LinearIssueMarkdownToolbarButton>
      <LinearIssueMarkdownToolbarSeparator />
      <LinearIssueMarkdownToolbarButton
        label={t('auto.components.LinearIssueMarkdownDescriptionEditor.c82917e06e', 'Bullet list')}
        active={active.bulletList}
        disabled={disabled}
        onClick={() =>
          runCommand((nextEditor) => nextEditor.chain().focus().toggleBulletList().run())
        }
      >
        <List className="size-3.5" />
      </LinearIssueMarkdownToolbarButton>
      <LinearIssueMarkdownToolbarButton
        label={t(
          'auto.components.LinearIssueMarkdownDescriptionEditor.d6b2f3d35b',
          'Numbered list'
        )}
        active={active.orderedList}
        disabled={disabled}
        onClick={() =>
          runCommand((nextEditor) => nextEditor.chain().focus().toggleOrderedList().run())
        }
      >
        <ListOrdered className="size-3.5" />
      </LinearIssueMarkdownToolbarButton>
      <LinearIssueMarkdownToolbarButton
        label={t('auto.components.LinearIssueMarkdownDescriptionEditor.e2a0267c8c', 'Checklist')}
        active={active.taskList}
        disabled={disabled}
        onClick={() =>
          runCommand((nextEditor) => nextEditor.chain().focus().toggleTaskList().run())
        }
      >
        <ListTodo className="size-3.5" />
      </LinearIssueMarkdownToolbarButton>
      <LinearIssueMarkdownToolbarSeparator />
      <LinearIssueMarkdownToolbarButton
        label={t('auto.components.LinearIssueMarkdownDescriptionEditor.9eaf02ac01', 'Quote')}
        active={active.blockquote}
        disabled={disabled}
        onClick={() =>
          runCommand((nextEditor) => nextEditor.chain().focus().toggleBlockquote().run())
        }
      >
        <Quote className="size-3.5" />
      </LinearIssueMarkdownToolbarButton>
      <LinearIssueMarkdownToolbarButton
        label={
          active.link
            ? t('auto.components.LinearIssueMarkdownDescriptionEditor.340160f4e8', 'Remove link')
            : t('auto.components.LinearIssueMarkdownDescriptionEditor.632096eb1c', 'Link')
        }
        active={active.link}
        disabled={disabled}
        onClick={() => runCommand(applyLinearIssueLink)}
      >
        <LinkIcon className="size-3.5" />
      </LinearIssueMarkdownToolbarButton>
    </div>
  )
}
