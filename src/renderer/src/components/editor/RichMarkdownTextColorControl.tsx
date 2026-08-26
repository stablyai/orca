import React from 'react'
import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import { Baseline, Eraser } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { RICH_MARKDOWN_TEXT_COLORS, type RichMarkdownTextColor } from './rich-markdown-text-color'

type RichMarkdownTextColorControlProps = {
  editor: Editor | null
  open?: boolean
  onOpenChange?: (open: boolean) => void
  closeOnSelectionCollapse?: boolean
}

function getColorLabel(color: RichMarkdownTextColor): string {
  const labels: Record<RichMarkdownTextColor, string> = {
    gray: translate('auto.components.editor.RichMarkdownTextColorControl.gray', 'Gray'),
    red: translate('auto.components.editor.RichMarkdownTextColorControl.red', 'Red'),
    orange: translate('auto.components.editor.RichMarkdownTextColorControl.orange', 'Orange'),
    yellow: translate('auto.components.editor.RichMarkdownTextColorControl.yellow', 'Yellow'),
    green: translate('auto.components.editor.RichMarkdownTextColorControl.green', 'Green'),
    teal: translate('auto.components.editor.RichMarkdownTextColorControl.teal', 'Teal'),
    blue: translate('auto.components.editor.RichMarkdownTextColorControl.blue', 'Blue'),
    purple: translate('auto.components.editor.RichMarkdownTextColorControl.purple', 'Purple'),
    pink: translate('auto.components.editor.RichMarkdownTextColorControl.pink', 'Pink')
  }
  return labels[color]
}

export function RichMarkdownTextColorControl({
  editor,
  open: controlledOpen,
  onOpenChange,
  closeOnSelectionCollapse = false
}: RichMarkdownTextColorControlProps): React.JSX.Element {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const currentColor = useEditorState({
    editor,
    selector: ({ editor: activeEditor }) => {
      if (!activeEditor) {
        return null
      }
      return (
        RICH_MARKDOWN_TEXT_COLORS.find((color) =>
          activeEditor.isActive('richMarkdownTextColor', { color })
        ) ?? null
      )
    }
  })
  const label = translate(
    'auto.components.editor.RichMarkdownTextColorControl.textColor',
    'Text color'
  )
  const clearLabel = translate(
    'auto.components.editor.RichMarkdownTextColorControl.clear',
    'Clear text color'
  )

  const setOpen = React.useCallback(
    (nextOpen: boolean): void => {
      if (controlledOpen === undefined) {
        setUncontrolledOpen(nextOpen)
      }
      onOpenChange?.(nextOpen)
    },
    [controlledOpen, onOpenChange]
  )

  React.useEffect(() => {
    if (!editor || !closeOnSelectionCollapse) {
      return
    }

    const closeForCollapsedSelection = (): void => {
      if (editor.state.selection.empty) {
        setOpen(false)
      }
    }

    editor.on('selectionUpdate', closeForCollapsedSelection)
    return () => {
      editor.off('selectionUpdate', closeForCollapsedSelection)
    }
  }, [closeOnSelectionCollapse, editor, setOpen])

  const setColor = (color: RichMarkdownTextColor): void => {
    editor?.chain().focus().setMark('richMarkdownTextColor', { color }).run()
    setOpen(false)
  }

  const clearColor = (): void => {
    editor?.chain().focus().unsetMark('richMarkdownTextColor').run()
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn('rich-markdown-toolbar-button', currentColor && 'is-active')}
              data-rich-markdown-text-color={currentColor ?? undefined}
              aria-label={label}
              onMouseDown={(event) => event.preventDefault()}
            >
              <Baseline className="size-3.5" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {label}
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        align="start"
        side="bottom"
        className="rich-markdown-text-color-popover"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="rich-markdown-text-color-options">
          {RICH_MARKDOWN_TEXT_COLORS.map((color) => {
            const colorLabel = getColorLabel(color)
            return (
              <Tooltip key={color}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      'rich-markdown-text-color-option',
                      currentColor === color && 'is-active'
                    )}
                    data-rich-markdown-text-color={color}
                    aria-label={colorLabel}
                    aria-pressed={currentColor === color}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setColor(color)}
                  >
                    <span className="rich-markdown-text-color-swatch" aria-hidden="true" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={4}>
                  {colorLabel}
                </TooltipContent>
              </Tooltip>
            )
          })}
          <div className="rich-markdown-text-color-divider" />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="rich-markdown-text-color-option"
                aria-label={clearLabel}
                onMouseDown={(event) => event.preventDefault()}
                onClick={clearColor}
              >
                <Eraser className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {clearLabel}
            </TooltipContent>
          </Tooltip>
        </div>
      </PopoverContent>
    </Popover>
  )
}
