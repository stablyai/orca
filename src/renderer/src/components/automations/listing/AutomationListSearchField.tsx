import React, { useRef } from 'react'
import { Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { RailPageSearch } from '@/components/rail-page/RailPageSearch'
import { Input } from '@/components/ui/input'
import { useTranslate } from '@/i18n/use-translate'
import {
  isAutomationListArrowKey,
  shouldHandleAutomationListSearchArrowKey,
  shouldHandleAutomationListSearchEnterKey,
  type AutomationListArrowKey
} from './automation-list-keyboard-navigation'

type AutomationListSearchFieldProps = {
  query: string
  isTooLarge: boolean
  onQueryChange: (query: string) => void
  onClear: () => void
  onArrowNavigate?: (key: AutomationListArrowKey) => void
  onEnter?: () => void
}

export function AutomationListSearchField({
  query,
  isTooLarge,
  onQueryChange,
  onClear,
  onArrowNavigate,
  onEnter
}: AutomationListSearchFieldProps): React.JSX.Element {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)
  const hasText = query !== ''
  const tooLargeMessage = isTooLarge
    ? t(
        'auto.components.automations.AutomationListSearchField.tooLong',
        'Search text is too long — list is unfiltered'
      )
    : null

  return (
    <RailPageSearch inputRef={inputRef} hasValue={hasText} focusTarget="automations">
      <div className="relative w-full">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          type="text"
          // Why: the page focuses this on user navigation; a restored page must not move focus.
          data-automations-page-search=""
          data-rail-page-focus-target=""
          value={query}
          aria-label={t(
            'auto.components.automations.AutomationListSearchField.label',
            'Search automations'
          )}
          placeholder={t(
            'auto.components.automations.AutomationListSearchField.placeholder',
            'Search...'
          )}
          aria-invalid={isTooLarge || undefined}
          aria-describedby={isTooLarge ? 'automations-list-search-too-large' : undefined}
          // Let the first Escape clear search without the page’s capture handler also blurring it.
          data-escape-clears-value={hasText ? 'true' : undefined}
          density="compact"
          surface="background"
          inset="leadingIcon"
          adornment={hasText ? (isTooLarge ? 'warningAndClear' : 'trailing') : 'shortcut'}
          focusFeedback="border"
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (
              onArrowNavigate &&
              isAutomationListArrowKey(event.key) &&
              shouldHandleAutomationListSearchArrowKey(event)
            ) {
              // Why: ArrowUp/Down should step the visible list instead of moving the input caret.
              event.preventDefault()
              onArrowNavigate(event.key)
              return
            }
            if (onEnter && shouldHandleAutomationListSearchEnterKey(event)) {
              event.preventDefault()
              onEnter()
              return
            }
            if (event.key !== 'Escape' || event.nativeEvent.isComposing) {
              return
            }
            if (!hasText) {
              return
            }
            event.preventDefault()
            onClear()
          }}
        />
        {hasText ? (
          <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
            {isTooLarge ? (
              <span
                id="automations-list-search-too-large"
                title={tooLargeMessage ?? undefined}
                className="text-3xs text-destructive"
              >
                {t(
                  'auto.components.automations.AutomationListSearchField.tooLongShort',
                  'Too long'
                )}
              </span>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t(
                'auto.components.automations.AutomationListSearchField.clear',
                'Clear search'
              )}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onClear()
                inputRef.current?.focus()
              }}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        ) : null}
        {isTooLarge ? (
          <div role="status" aria-live="polite" className="sr-only">
            {tooLargeMessage}
          </div>
        ) : null}
      </div>
    </RailPageSearch>
  )
}
