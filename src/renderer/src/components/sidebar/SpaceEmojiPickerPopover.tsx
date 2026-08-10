import React from 'react'
import EmojiPicker, { EmojiStyle, Theme, type EmojiClickData } from 'emoji-picker-react'
import { Smile } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useSystemPrefersDark } from '@/components/terminal-pane/use-system-prefers-dark'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

type SpaceEmojiPickerPopoverProps = {
  emoji: string | null
  disabled?: boolean
  onEmojiSelect: (emoji: string | null) => void
}

export function SpaceEmojiPickerPopover({
  emoji,
  disabled = false,
  onEmojiSelect
}: SpaceEmojiPickerPopoverProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const settingsTheme = useAppStore((state) => state.settings?.theme ?? 'system')
  const systemPrefersDark = useSystemPrefersDark()
  const isDark = settingsTheme === 'dark' || (settingsTheme === 'system' && systemPrefersDark)

  const handleEmojiClick = React.useCallback(
    (data: EmojiClickData) => {
      onEmojiSelect(data.emoji)
      setOpen(false)
    },
    [onEmojiSelect]
  )

  const handleClear = React.useCallback(() => {
    onEmojiSelect(null)
    setOpen(false)
  }, [onEmojiSelect])

  // Why: this popover is portaled out of the scroll-locked Space editor dialog,
  // so the dialog's wheel lock swallows native scrolling over the emoji grid.
  const handleWheel = React.useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const body = event.currentTarget.querySelector<HTMLElement>('.epr-body')
    if (!body || body.scrollHeight <= body.clientHeight) {
      return
    }
    const delta =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? event.deltaY * 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? event.deltaY * body.clientHeight
          : event.deltaY
    const previousScrollTop = body.scrollTop
    const nextScrollTop = Math.max(
      0,
      Math.min(body.scrollHeight - body.clientHeight, previousScrollTop + delta)
    )
    if (nextScrollTop === previousScrollTop) {
      return
    }
    event.stopPropagation()
    // Why: stopping propagation can also let the browser scroll natively; apply
    // the delta only when it didn't, so one wheel tick never scrolls twice.
    requestAnimationFrame(() => {
      if (body.scrollTop === previousScrollTop) {
        body.scrollTop = nextScrollTop
      }
    })
  }, [])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          className="h-8 w-10 justify-center px-0 text-base"
          aria-label={translate(
            'auto.components.sidebar.SpaceEmojiPickerPopover.chooseEmoji',
            'Choose Space emoji'
          )}
        >
          {emoji ? (
            <span aria-hidden="true">{emoji}</span>
          ) : (
            <Smile aria-hidden="true" className="size-4 text-muted-foreground" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto border-none p-0">
        <div
          className="repo-icon-emoji-picker overflow-hidden rounded-md border bg-popover"
          onWheel={handleWheel}
        >
          <EmojiPicker
            autoFocusSearch
            emojiStyle={EmojiStyle.NATIVE}
            height={340}
            lazyLoadEmojis
            onEmojiClick={handleEmojiClick}
            previewConfig={{ showPreview: false }}
            searchPlaceholder={translate(
              'auto.components.sidebar.SpaceEmojiPickerPopover.searchPlaceholder',
              'Search emoji'
            )}
            skinTonesDisabled
            theme={isDark ? Theme.DARK : Theme.LIGHT}
            width={300}
          />
          {emoji ? (
            <div className="border-t p-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 w-full justify-center text-xs text-muted-foreground"
                onClick={handleClear}
              >
                {translate(
                  'auto.components.sidebar.SpaceEmojiPickerPopover.removeEmoji',
                  'Remove emoji'
                )}
              </Button>
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
