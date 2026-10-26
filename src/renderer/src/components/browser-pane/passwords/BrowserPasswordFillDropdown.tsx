import type { MutableRefObject, RefObject } from 'react'
import { KeyRound } from 'lucide-react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
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
  containerRef,
  webviewRef
}: {
  browserPageId: string
  containerRef: RefObject<HTMLDivElement | null>
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
}): React.JSX.Element | null {
  const { focusedField, focusedFieldShownAt } = useBrowserPasswordPageState(browserPageId)
  if (!focusedField || focusedField.suggestions.length === 0) {
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
    />
  )
}

function BrowserPasswordFillList({
  browserPageId,
  field,
  shownAt,
  anchor
}: {
  browserPageId: string
  field: BrowserPasswordFieldFocusEvent
  shownAt: number
  anchor: React.CSSProperties
}): React.JSX.Element {
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
    <button
      key={suggestion.entryId}
      type="button"
      className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      // Why on press: pressing here blurs the page's field, which closes this list before a click lands.
      onMouseDown={(event) => {
        event.preventDefault()
        if (event.button === 0) {
          choose(suggestion)
        }
      }}
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
    </button>
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
        // Why: focus must stay in the page's field, or the list would close itself.
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <div className="p-1">
          <div className="px-2 pb-1 pt-1.5 text-xs text-muted-foreground">
            {translate('browser.passwords.fill.title', 'Saved logins')}
          </div>
          {exact.map(renderRow)}
          {sameSite.length > 0 ? (
            <>
              <div className="px-2 pb-1 pt-2 text-xs text-muted-foreground">
                {translate('browser.passwords.fill.otherLogins', 'Other logins on this site')}
              </div>
              {sameSite.map(renderRow)}
            </>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
