import { useEffect, useState } from 'react'
import type { Terminal } from '@xterm/xterm'
import { ArrowDownToLine } from 'lucide-react'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { isTerminalViewportAtBottom } from '@/lib/pane-manager/terminal-scroll-intent'
import { followTerminalOutput } from './terminal-auto-scroll'

export function TerminalJumpToBottomButton({
  terminal
}: {
  terminal: Terminal
}): React.JSX.Element | null {
  const [isAtBottom, setIsAtBottom] = useState(() => isTerminalViewportAtBottom(terminal))

  useEffect(() => {
    let pendingFrameId: number | null = null
    const update = (): void => {
      pendingFrameId = null
      setIsAtBottom(isTerminalViewportAtBottom(terminal))
    }
    const scheduleUpdate = (): void => {
      if (pendingFrameId !== null) {
        return
      }
      // Why: xterm emits scroll while parsing output. Read once after the batch
      // so the affordance reflects the scheduler's final enforced scroll intent.
      pendingFrameId = requestAnimationFrame(update)
    }
    const scrollDisposable = terminal.onScroll(scheduleUpdate)
    const writeDisposable = terminal.onWriteParsed(scheduleUpdate)
    update()
    return () => {
      if (pendingFrameId !== null) {
        cancelAnimationFrame(pendingFrameId)
      }
      scrollDisposable.dispose()
      writeDisposable.dispose()
    }
  }, [terminal])

  if (isAtBottom) {
    return null
  }

  const label = translate(
    'auto.components.terminal.pane.TerminalJumpToBottomButton.jumpToBottom',
    'Jump to bottom'
  )
  const isMac = navigator.userAgent.includes('Mac')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          className="absolute right-5 bottom-2 z-20"
          aria-label={label}
          onClick={() => followTerminalOutput(terminal, { focus: true })}
        >
          <ArrowDownToLine data-icon="inline-start" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4} className="flex items-center gap-2">
        <span>{label}</span>
        {isMac ? <ShortcutKeyCombo keys={['⌘', '↓']} /> : null}
      </TooltipContent>
    </Tooltip>
  )
}
