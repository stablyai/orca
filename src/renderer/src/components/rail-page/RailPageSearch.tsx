import React from 'react'
import { Search, X } from 'lucide-react'
import { ShortcutKeyCombo } from '@/components/ui/ShortcutKeyCombo'
import { Button } from '@/components/ui/button'
import { useShortcutKeyComboDetails } from '@/lib/keyboard/useShortcutLabel'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useRailPageRoot } from './RailPage'
import { useRailPageSearchShortcut } from './rail-page-search-shortcut'

export function RailPageSearch({
  inputRef,
  hasValue,
  disabled = false,
  focusTarget,
  shortcutEnabled = true,
  children,
  className
}: {
  inputRef: React.RefObject<HTMLInputElement | null>
  hasValue: boolean
  disabled?: boolean
  focusTarget?: 'page' | 'automations'
  shortcutEnabled?: boolean
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  const rootRef = useRailPageRoot()
  const fallbackRootRef = React.useRef<HTMLElement | null>(null)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const selectOnOpen = React.useRef(false)
  const [expanded, setExpanded] = React.useState(false)
  const fieldId = React.useId()
  const webClient = isWebClientLocation()
  const openForShortcut = React.useCallback(() => {
    selectOnOpen.current = true
    setExpanded(true)
  }, [])
  useRailPageSearchShortcut({
    rootRef: rootRef ?? fallbackRootRef,
    inputRef,
    triggerRef,
    openForShortcut,
    enabled: shortcutEnabled && !webClient
  })
  React.useLayoutEffect(() => {
    if (focusTarget === 'page') {
      const input = inputRef.current
      const target = input?.checkVisibility() ? input : triggerRef.current
      target?.focus({ preventScroll: true })
    }
  }, [focusTarget, inputRef])
  React.useLayoutEffect(() => {
    if (expanded) {
      if (disabled) {
        selectOnOpen.current = false
        setExpanded(false)
        return
      }
      inputRef.current?.focus({ preventScroll: true })
      if (selectOnOpen.current) {
        inputRef.current?.select()
        selectOnOpen.current = false
      }
    }
  }, [disabled, expanded, inputRef])

  const combos = useShortcutKeyComboDetails('page.search')
  const showHint = shortcutEnabled && !webClient && !hasValue && combos.length > 0
  return (
    <div data-rail-page-search="" className={cn('flex flex-none items-center', className)}>
      <Button
        ref={triggerRef}
        type="button"
        variant="outline"
        size="icon-toolbar"
        data-rail-page-search-trigger=""
        disabled={disabled}
        data-rail-page-focus-target={focusTarget === 'page' ? '' : undefined}
        data-automations-page-search={focusTarget === 'automations' ? '' : undefined}
        aria-label={t('common.search', 'Search')}
        aria-controls={fieldId}
        aria-expanded={expanded}
        tabIndex={expanded ? -1 : undefined}
        onClick={() => setExpanded(true)}
      >
        <Search className="size-3.5" />
      </Button>
      <div
        id={fieldId}
        data-rail-page-search-field=""
        data-expanded={expanded ? 'true' : undefined}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setExpanded(false)
          }
        }}
        className="group/rail-search relative flex w-full min-w-0 items-center"
      >
        {children}
        {showHint ? (
          <span
            aria-hidden
            data-rail-page-search-hint=""
            className="pointer-events-none absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center group-focus-within/rail-search:hidden"
          >
            {combos.slice(0, 1).map((combo) => (
              <ShortcutKeyCombo
                key={combo.keys.join('-')}
                keys={combo.keys}
                doubleTap={combo.doubleTap}
                size="compact"
              />
            ))}
          </span>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-toolbar"
          data-rail-page-search-close=""
          aria-label={t('auto.components.railPage.closeSearch', 'Close search')}
          onClick={() => {
            triggerRef.current?.focus({ preventScroll: true })
            setExpanded(false)
          }}
        >
          <X className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}
