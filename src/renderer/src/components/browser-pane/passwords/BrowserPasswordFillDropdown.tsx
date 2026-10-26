import { useCallback, useEffect, useState, type MutableRefObject, type RefObject } from 'react'
import { KeyRound } from 'lucide-react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import {
  Command,
  CommandInput,
  CommandList,
  CommandItem,
  CommandGroup
} from '@/components/ui/command'
import { translate } from '@/i18n/i18n'
import type {
  BrowserPasswordFieldFocusEvent,
  BrowserPasswordSuggestion
} from '../../../../../shared/browser-passwords-types'
import {
  clearBrowserPasswordFocusedField,
  isBrowserPasswordFillClickAllowed,
  useBrowserPasswordPageState
} from './browser-password-page-store'

function hostOf(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

/** Places the anchor under the guest field, scaling guest CSS pixels to pane pixels. */
function anchorStyle(
  field: BrowserPasswordFieldFocusEvent,
  container: HTMLElement | null,
  webview: HTMLElement | null
): React.CSSProperties | null {
  if (!container || !webview) {
    return null
  }
  const containerRect = container.getBoundingClientRect()
  const webviewRect = webview.getBoundingClientRect()
  const scale =
    field.viewportWidth > 0 && webviewRect.width > 0 ? webviewRect.width / field.viewportWidth : 1
  return {
    left: webviewRect.left - containerRect.left + field.rect.x * scale,
    top: webviewRect.top - containerRect.top + field.rect.y * scale,
    width: field.rect.width * scale,
    height: field.rect.height * scale
  }
}

/** Orca-drawn list of saved logins for the focused field; the page can neither see nor click it. */
export function BrowserPasswordFillDropdown({
  browserPageId,
  isActive,
  containerRef,
  webviewRef
}: {
  browserPageId: string
  isActive: boolean
  containerRef: RefObject<HTMLDivElement | null>
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
}): React.JSX.Element | null {
  const { focusedField, focusedFieldShownAt } = useBrowserPasswordPageState(browserPageId)
  useEffect(() => {
    if (!isActive && focusedField) {
      clearBrowserPasswordFocusedField(browserPageId)
    }
  }, [browserPageId, isActive, focusedField])
  if (!isActive || !focusedField || focusedField.suggestions.length === 0) {
    return null
  }
  const style = anchorStyle(focusedField, containerRef.current, webviewRef.current)
  if (!style) {
    return null
  }
  return (
    <BrowserPasswordFillList
      key={focusedField.fieldToken}
      browserPageId={browserPageId}
      field={focusedField}
      shownAt={focusedFieldShownAt}
      anchor={style}
      onEscape={() => webviewRef.current?.focus()}
    />
  )
}

function BrowserPasswordFillList({
  browserPageId,
  field,
  shownAt,
  anchor,
  onEscape
}: {
  browserPageId: string
  field: BrowserPasswordFieldFocusEvent
  shownAt: number
  anchor: React.CSSProperties
  onEscape: () => void
}): React.JSX.Element {
  const [selectedEntryId, setSelectedEntryId] = useState(field.suggestions[0]?.entryId ?? '')
  const focusPicker = useCallback(
    (node: HTMLInputElement | null) => {
      if (field.keyboardSelection) {
        node?.focus()
      }
    },
    [field.keyboardSelection]
  )
  const exact = field.suggestions.filter((suggestion) => suggestion.exactOrigin)
  const sameSite = field.suggestions.filter((suggestion) => !suggestion.exactOrigin)

  const choose = (suggestion: BrowserPasswordSuggestion): void => {
    if (!isBrowserPasswordFillClickAllowed(shownAt)) {
      return
    }
    clearBrowserPasswordFocusedField(browserPageId)
    void window.api.browserPasswords.fillLogin({
      browserPageId,
      fieldToken: field.fieldToken,
      entryId: suggestion.entryId
    })
  }

  const renderRow = (suggestion: BrowserPasswordSuggestion): React.JSX.Element => (
    <CommandItem
      key={suggestion.entryId}
      value={suggestion.entryId}
      selection="palette"
      onMouseDown={(event) => event.preventDefault()}
      onSelect={() => choose(suggestion)}
    >
      <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate">
          {suggestion.username || translate('browser.passwords.fill.noUsername', '(no username)')}
        </span>
        {suggestion.exactOrigin ? null : (
          <span className="block truncate text-xs text-muted-foreground">
            {hostOf(suggestion.origin)}
          </span>
        )}
      </span>
    </CommandItem>
  )

  return (
    <Popover open onOpenChange={(open) => !open && clearBrowserPasswordFocusedField(browserPageId)}>
      <PopoverAnchor asChild>
        <div className="pointer-events-none absolute" style={anchor} />
      </PopoverAnchor>
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={4}
        className="w-72"
        onEscapeKeyDown={onEscape}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <Command
          label={translate('browser.passwords.fill.title', 'Saved logins')}
          shouldFilter={false}
          value={selectedEntryId}
          onValueChange={setSelectedEntryId}
          onKeyDown={(event) => {
            if (event.key === ' ') {
              event.preventDefault()
              const selected = field.suggestions.find((entry) => entry.entryId === selectedEntryId)
              if (selected) {
                choose(selected)
              }
            }
          }}
        >
          <CommandInput ref={focusPicker} readOnly wrapperClassName="sr-only" />
          <CommandList>
            <CommandGroup heading={translate('browser.passwords.fill.title', 'Saved logins')}>
              {exact.map(renderRow)}
            </CommandGroup>
            {sameSite.length > 0 ? (
              <CommandGroup
                heading={translate(
                  'browser.passwords.fill.otherLogins',
                  'Other logins on this site'
                )}
              >
                {sameSite.map(renderRow)}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
