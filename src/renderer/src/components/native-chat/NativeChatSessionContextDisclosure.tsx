import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { NativeChatContextDisclosure } from './native-chat-context-disclosure'

export function NativeChatSessionContextDisclosure({
  disclosure
}: {
  disclosure: NativeChatContextDisclosure
}): React.JSX.Element | null {
  if (disclosure.contextSectionCount === 0) {
    return null
  }

  return (
    <details className={cn(disclosure.visibleText && 'mt-2 border-t border-border/60 pt-1.5')}>
      <summary className="cursor-pointer select-none py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {translate('components.native-chat.sessionContext', 'Session context')}
        <span className="ml-1 font-normal opacity-70">
          {translate('components.native-chat.sessionContextSections', '· {{value0}} sections', {
            value0: disclosure.contextSectionCount
          })}
        </span>
      </summary>
      <pre className="scrollbar-sleek mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background/60 p-2 text-[10px] leading-relaxed text-muted-foreground">
        {disclosure.contextText}
      </pre>
    </details>
  )
}
