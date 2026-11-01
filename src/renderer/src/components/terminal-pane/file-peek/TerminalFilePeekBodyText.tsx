import { useLayoutEffect, useRef } from 'react'
import { NativeChatHighlightedCode } from '@/components/native-chat/NativeChatHighlightedCode'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { TerminalFilePeekContent } from './terminal-file-peek-content-types'
import { TerminalFilePeekBodyScroll } from './TerminalFilePeekBodyScroll'

type TextContent = Extract<TerminalFilePeekContent, { kind: 'text' }>

/** A highlighted excerpt with a line-number gutter, the referenced line marked and centered. */
export function TerminalFilePeekBodyText({ content }: { content: TextContent }): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const targetRowRef = useRef<HTMLDivElement>(null)
  const targetIndex =
    content.targetLine === null ? -1 : content.targetLine - content.firstLineNumber
  const hasTarget = targetIndex >= 0 && targetIndex < content.lines.length

  // Why: scrollIntoView could also move the popover or the page, so only this frame scrolls.
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    const row = targetRowRef.current
    if (scroller && row) {
      scroller.scrollTop = row.offsetTop - (scroller.clientHeight - row.offsetHeight) / 2
    }
  }, [content])

  return (
    <>
      <TerminalFilePeekBodyScroll ref={scrollRef}>
        <div className="relative flex font-mono text-xs leading-5">
          {hasTarget ? (
            <div
              ref={targetRowRef}
              aria-hidden="true"
              data-current="true"
              className="absolute inset-x-0 h-5 bg-foreground/10"
              style={{ top: `calc(var(--spacing) * 5 * ${targetIndex})` }}
            />
          ) : null}
          <div
            aria-hidden="true"
            className="relative shrink-0 select-none pr-2 text-right text-muted-foreground tabular-nums"
          >
            {content.lines.map((_, index) => (
              <div
                key={content.firstLineNumber + index}
                className={cn(index === targetIndex && 'text-foreground')}
              >
                {content.firstLineNumber + index}
              </div>
            ))}
          </div>
          <pre className="relative min-w-0 flex-1 overflow-hidden [mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)]">
            <code>
              <NativeChatHighlightedCode
                code={content.lines.join('\n')}
                language={content.language}
              />
            </code>
          </pre>
        </div>
      </TerminalFilePeekBodyScroll>
      {content.truncatedLines ? (
        <p className="mt-1 text-2xs text-muted-foreground">
          {translate('terminal.filePeek.truncatedLines', 'Long lines are cut off.')}
        </p>
      ) : null}
    </>
  )
}
