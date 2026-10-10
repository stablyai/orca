import { useEffect } from 'react'
import './native-chat-find.css'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ImeInput } from '@/lib/ime-text-field'
import { translate } from '@/i18n/i18n'
import type { NativeChatFind } from './use-native-chat-find'
import { useNativeChatFindMatches } from './use-native-chat-find-matches'

/** Find over the chat transcript, at the top-right of the transcript area like the terminal's search. */
export function NativeChatFindBar({
  find,
  isVisible
}: {
  find: NativeChatFind
  isVisible: boolean
}): React.JSX.Element {
  const { query, setQuery, close, rootRef, barRef, inputRef, revealMatch } = find
  const { matchCount, activeIndex, step } = useNativeChatFindMatches({
    rootRef,
    barRef,
    query,
    isVisible,
    revealMatch
  })

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [inputRef])

  const status =
    query && matchCount === 0
      ? translate('components.native-chat.find.noResults', 'No results')
      : `${activeIndex + 1}/${matchCount}`
  const previousLabel = translate('components.native-chat.find.previousMatch', 'Previous match')
  const nextLabel = translate('components.native-chat.find.nextMatch', 'Next match')
  const closeLabel = translate('components.native-chat.find.close', 'Close')

  return (
    <div
      ref={barRef}
      role="search"
      // The chat sends clicks on its plain surface to the composer; the bar's are its own.
      data-native-chat-typing-redirect-ignore="true"
      data-native-chat-find-bar="true"
      className="absolute top-2 right-4 z-20 flex w-85 max-w-[calc(100%-2rem)] items-center gap-1 rounded-lg border border-border bg-popover/95 px-2 py-1 text-popover-foreground shadow-floating backdrop-blur-sm"
      onMouseDown={(event) => {
        // A press on the count or padding keeps typing in the find input.
        if (!(event.target instanceof Element) || !event.target.closest('button, input')) {
          event.preventDefault()
          inputRef.current?.focus()
        }
      }}
      onKeyDown={(event) => {
        // Buttons keep their own Enter (Previous, Close); only the input steps.
        if (event.key === 'Enter' && event.target === inputRef.current) {
          event.preventDefault()
          step(event.shiftKey ? -1 : 1)
        }
      }}
    >
      <ImeInput
        ref={inputRef}
        type="text"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={translate('components.native-chat.find.label', 'Find in chat')}
        aria-label={translate('components.native-chat.find.label', 'Find in chat')}
        className="min-w-0 flex-1 border-none bg-transparent text-sm text-popover-foreground outline-none placeholder:text-muted-foreground"
      />
      <span
        aria-live="polite"
        className="shrink-0 whitespace-nowrap px-1 text-xs tabular-nums text-muted-foreground"
      >
        {status}
      </span>
      <div className="mx-0.5 h-4 w-px bg-border" />
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={() => step(-1)}
        disabled={matchCount === 0}
        className="shrink-0"
        title={previousLabel}
        aria-label={previousLabel}
      >
        <ChevronUp size={14} />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={() => step(1)}
        disabled={matchCount === 0}
        className="shrink-0"
        title={nextLabel}
        aria-label={nextLabel}
      >
        <ChevronDown size={14} />
      </Button>
      <div className="mx-0.5 h-4 w-px bg-border" />
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={close}
        className="shrink-0"
        title={closeLabel}
        aria-label={closeLabel}
      >
        <X size={14} />
      </Button>
    </div>
  )
}
