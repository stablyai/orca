import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { SideQuestQuoteCard } from './SideQuestQuoteCard'
import { useNativeChatSideQuestContext } from './use-native-chat-side-quest-context'

export function ProviderSideQuestComposer({
  terminalTabId,
  providerReady,
  isWorking,
  error,
  onSend,
  onStop
}: {
  terminalTabId: string
  providerReady: boolean
  isWorking: boolean
  error: string | null
  onSend: (text: string, visibleText?: string) => Promise<boolean>
  onStop: () => Promise<void>
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const { context, clearContext, buildSubmittedText } = useNativeChatSideQuestContext(terminalTabId)
  const canSend = providerReady && draft.trim().length > 0 && !isWorking

  useEffect(() => {
    textareaRef.current?.focus()
  }, [terminalTabId])

  const submit = async (): Promise<void> => {
    if (!canSend) {
      return
    }
    const submittedText = buildSubmittedText(draft, false)
    if (!submittedText) {
      return
    }
    setDraft('')
    const sent = await onSend(submittedText, draft)
    if (sent) {
      clearContext()
    } else {
      setDraft((current) => current || draft)
    }
  }

  return (
    <div className="shrink-0 bg-background px-3 py-2 sm:px-4">
      <div className="relative mx-auto w-full max-w-3xl">
        <div
          className={cn(
            'rounded-lg border border-border bg-muted/50 p-1.5 shadow-xs',
            'dark:bg-input/40'
          )}
        >
          {context ? (
            <div className="mb-2 px-1">
              <SideQuestQuoteCard
                sourceLabel={context.sourceLabel}
                text={context.text}
                onRemove={clearContext}
              />
            </div>
          ) : null}
          <textarea
            ref={textareaRef}
            value={draft}
            rows={2}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void submit()
              }
            }}
            placeholder={translate(
              'components.native-chat.sideQuest.draftPlaceholder',
              'Draft your question…'
            )}
            className="scrollbar-sleek min-h-12 max-h-28 w-full resize-none bg-transparent px-2 py-1 text-sm outline-none placeholder:text-muted-foreground/60 pointer-coarse:min-h-14"
          />
          {!providerReady && !error ? (
            <p className="px-2 pb-1 text-xs text-muted-foreground" role="status">
              {translate(
                'components.native-chat.sideQuest.starting',
                'Starting the Side Quest agent… You can draft while it gets ready.'
              )}
            </p>
          ) : null}
          {error ? (
            <p className="px-2 pb-1 text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex items-center justify-end pt-0.5">
            <Button
              type="button"
              aria-label={
                isWorking
                  ? translate('components.native-chat.stop', 'Stop the agent')
                  : translate('components.native-chat.composer.send', 'Send')
              }
              disabled={isWorking ? false : !canSend}
              onClick={() => (isWorking ? void onStop() : void submit())}
              variant={isWorking ? 'secondary' : 'default'}
              size="icon"
              className="size-8 rounded-full pointer-coarse:size-10"
            >
              {isWorking ? (
                <Square className="size-3.5 fill-current" />
              ) : (
                <ArrowUp className="size-4" />
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
