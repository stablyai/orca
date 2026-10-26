import { useSyncExternalStore } from 'react'
import type {
  BrowserPasswordFieldFocusEvent,
  BrowserPasswordSavePrompt
} from '../../../../../shared/browser-passwords-types'

type PageState = {
  savePrompt: BrowserPasswordSavePrompt | null
  focusedField: BrowserPasswordFieldFocusEvent | null
  /** `performance.now()` when the focused field's list was first offered. */
  focusedFieldShownAt: number
}

const EMPTY_PAGE_STATE: PageState = { savePrompt: null, focusedField: null, focusedFieldShownAt: 0 }

const pages = new Map<string, PageState>()
const listeners = new Set<() => void>()
let installed = false

function update(browserPageId: string, patch: Partial<PageState>): void {
  const next = { ...(pages.get(browserPageId) ?? EMPTY_PAGE_STATE), ...patch }
  if (!next.savePrompt && !next.focusedField) {
    pages.delete(browserPageId)
  } else {
    pages.set(browserPageId, next)
  }
  for (const listener of listeners) {
    listener()
  }
}

// Why one app-wide subscription: a save offer must not be lost while its pane is between mounts.
function install(): void {
  if (installed || !window.api?.browserPasswords) {
    return
  }
  installed = true
  const api = window.api.browserPasswords
  api.onSavePrompt((prompt) => update(prompt.browserPageId, { savePrompt: prompt }))
  api.onSavePromptClosed(({ promptId }) => {
    for (const [browserPageId, state] of pages) {
      if (state.savePrompt?.promptId === promptId) {
        update(browserPageId, { savePrompt: null })
      }
    }
  })
  api.onFieldFocus((event) =>
    update(event.browserPageId, { focusedField: event, focusedFieldShownAt: performance.now() })
  )
  api.onFieldBlur((event) => {
    if (pages.get(event.browserPageId)?.focusedField?.fieldToken === event.fieldToken) {
      update(event.browserPageId, { focusedField: null })
    }
  })
}

function subscribe(listener: () => void): () => void {
  install()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useBrowserPasswordPageState(browserPageId: string): PageState {
  return useSyncExternalStore(subscribe, () => pages.get(browserPageId) ?? EMPTY_PAGE_STATE)
}

export function clearBrowserPasswordFocusedField(browserPageId: string): void {
  update(browserPageId, { focusedField: null })
}

export function clearBrowserPasswordSavePrompt(browserPageId: string): void {
  update(browserPageId, { savePrompt: null })
}

// Chrome ignores clicks on its fill popup for this long after it appears, against clickjacking.
const FILL_CLICK_GUARD_MS = 500

export function isBrowserPasswordFillClickAllowed(shownAt: number): boolean {
  return performance.now() - shownAt >= FILL_CLICK_GUARD_MS
}
