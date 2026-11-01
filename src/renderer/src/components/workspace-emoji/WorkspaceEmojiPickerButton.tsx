import { memo, useRef, useState, type RefObject } from 'react'
import { Smile } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { lazyWithPreload } from '@/lib/lazy-with-retry'
import { insertWorkspaceEmojiAtSelection } from '@/lib/workspace-emoji-shortcodes'
import { cn } from '@/lib/utils'

// Why: keeps the picker out of the boot bundle; preloaded on hover/focus so the first open is instant.
const WorkspaceEmojiPickerPanel = lazyWithPreload(
  () =>
    import('./WorkspaceEmojiPickerPanel').then((module) => ({
      default: module.WorkspaceEmojiPickerPanel
    })),
  { reloadKey: 'workspace-emoji-picker-panel' }
)

type WorkspaceEmojiPickerButtonProps = {
  className?: string
  disabled?: boolean
  inputRef: RefObject<HTMLInputElement | null>
  onOpenChange?: (open: boolean) => void
  onValueChange: (value: string) => void
  portalContainer?: HTMLElement | null
}

/**
 * Memoized and value-free (it reads the input at pick time) so typing in the
 * name field does not re-render the button, tooltip, or popover.
 */
export const WorkspaceEmojiPickerButton = memo(function WorkspaceEmojiPickerButton({
  className,
  disabled = false,
  inputRef,
  onOpenChange,
  onValueChange,
  portalContainer
}: WorkspaceEmojiPickerButtonProps): React.JSX.Element {
  // Why: memo would otherwise keep the label and tooltip in the previous UI language.
  useUiLanguageRevision()
  const [open, setOpen] = useState(false)
  // Why: the input loses focus while the picker is open, so remember where to insert.
  const selectionRef = useRef<{ start: number; end: number } | null>(null)
  const pendingCursorRef = useRef<number | null>(null)

  const handleOpenChange = (nextOpen: boolean): void => {
    if (nextOpen) {
      const input = inputRef.current
      const length = input?.value.length ?? 0
      selectionRef.current = {
        start: input?.selectionStart ?? length,
        end: input?.selectionEnd ?? length
      }
      pendingCursorRef.current = null
    }
    setOpen(nextOpen)
    onOpenChange?.(nextOpen)
  }

  const handlePick = (emoji: string): void => {
    const value = inputRef.current?.value ?? ''
    const selection = selectionRef.current ?? { start: value.length, end: value.length }
    const replacement = insertWorkspaceEmojiAtSelection(
      value,
      selection.start,
      selection.end,
      emoji
    )
    onValueChange(replacement.value)
    pendingCursorRef.current = replacement.cursor
    setOpen(false)
    onOpenChange?.(false)
  }

  const label = translate('workspace.links.addEmoji', 'Add emoji')

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={label}
              disabled={disabled}
              onPointerEnter={WorkspaceEmojiPickerPanel.preload}
              onFocus={WorkspaceEmojiPickerPanel.preload}
              onKeyDown={(event) => event.stopPropagation()}
              className={cn(
                'flex size-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 data-[state=open]:bg-accent data-[state=open]:text-foreground',
                className
              )}
            >
              <Smile className="size-3.5" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">
          {translate('workspace.links.addEmojiTooltip', 'Add emoji (or type :)')}
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        align="end"
        side="bottom"
        portalContainer={portalContainer}
        onKeyDown={(event) => event.stopPropagation()}
        onCloseAutoFocus={(event) => {
          const cursor = pendingCursorRef.current
          if (cursor === null) {
            return
          }
          // Why: after a pick, return focus to the name field (not the trigger) so typing continues.
          pendingCursorRef.current = null
          event.preventDefault()
          inputRef.current?.focus({ preventScroll: true })
          inputRef.current?.setSelectionRange(cursor, cursor)
        }}
      >
        {open ? <WorkspaceEmojiPickerPanel onPick={handlePick} /> : null}
      </PopoverContent>
    </Popover>
  )
})
