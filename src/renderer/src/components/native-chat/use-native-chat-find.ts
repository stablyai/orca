import {
  createNativeChatReturnField,
  useNativeChatReturnRef,
  useNativeChatReturnState
} from './native-chat-view-state-memory'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject
} from 'react'
import { keybindingMatchesAction } from '../../../../shared/keybindings'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { isEditableTarget } from '@/lib/editable-target'
import { isWebClientLocation } from '@/lib/web-client-location'
import { useAppStore } from '../../store'
import type { NativeChatComposerHandle } from './native-chat-composer-types'
import type { useNativeChatRevealLatest } from './use-native-chat-reveal-latest'
import { focusNativeChatPromptCard } from './use-native-chat-prompt-card-focus'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/app-keyboard-router'

export type NativeChatFindLocation = { row: string; occurrence: number }
const navigation = createNativeChatReturnField<{
  epoch: string | null
  query: string
  pending: boolean
  selected: NativeChatFindLocation | null
}>()
const findOpen = createNativeChatReturnField<boolean>()
const findQuery = createNativeChatReturnField<string>()

/** The chat's find: open state and query live with the chat, so a reopen keeps the last query. */
export type NativeChatFind = {
  isOpen: boolean
  query: string
  setQuery: (query: string) => void
  close: () => void
  /** Opens the bar, or refocuses it when open; absent where the chat's find does not run. */
  open: ((returnFocusTo?: Element | null) => void) | undefined
  /** For the chat root's onKeyDownCapture: an Escape while open closes the bar. */
  onKeyDownCapture: (event: ReactKeyboardEvent) => void
  rootRef: RefObject<HTMLDivElement | null>
  barRef: RefObject<HTMLDivElement | null>
  inputRef: RefObject<HTMLInputElement | null>
  /** Brings a match into the transcript's view, clear of the bar, as a reader step would. */
  revealMatch: (match: Range) => void
  completeSearch: (match: Range | null) => boolean
  selection: () => NativeChatFindLocation | null
  selectMatch: (location: NativeChatFindLocation | null) => void
  cancelNavigation: () => void
}

/** A composer whose suggestion list is open spends its own Escape closing that list. */
function ownsEscape(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    isEditableTarget(target) &&
    target.getAttribute('aria-expanded') === 'true'
  )
}

function focusInput(input: HTMLInputElement): void {
  input.focus()
  input.select()
}

/** Mod+F inside the focused chat opens find over its transcript. */
export function useNativeChatFind(
  enabled: boolean,
  rootRef: RefObject<HTMLDivElement | null>,
  composerRef: RefObject<Pick<NativeChatComposerHandle, 'focus'> | null>,
  {
    messageListRef,
    epoch = null,
    navigationRef
  }: Pick<
    ReturnType<typeof useNativeChatRevealLatest>,
    'messageListRef' | 'epoch' | 'navigationRef'
  >
): NativeChatFind {
  const [isOpen, setIsOpen] = useNativeChatReturnState(findOpen, () => false)
  const [query, setQuery] = useNativeChatReturnState(findQuery, () => '')
  const intent = useNativeChatReturnRef(navigation, () => ({
    epoch,
    query,
    pending: false,
    selected: null
  }))
  const cancelNavigation = useCallback(() => {
    intent.current.pending = false
  }, [intent])
  useLayoutEffect(() => {
    if (epoch !== null) {
      if (intent.current.epoch !== null && intent.current.epoch !== epoch) {
        intent.current = { epoch, query, pending: false, selected: null }
      }
      intent.current.epoch = epoch
    }
    navigationRef.current = cancelNavigation
    return () => {
      navigationRef.current = null
    }
  }, [epoch, intent, navigationRef, cancelNavigation, query])
  const accept = useCallback(
    (next: string) => {
      if (!intent.retired) {
        intent.current = { epoch: intent.current.epoch, query: next, pending: true, selected: null }
      }
    },
    [intent]
  )
  const changeQuery = useCallback(
    (next: string) => {
      if (next !== query) {
        accept(next)
        setQuery(next)
      }
    },
    [accept, query, setQuery]
  )
  const barRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const requestedFocus = useRef(false)
  const focusBeforeOpenRef = useRef<HTMLElement | null>(null)

  const close = useCallback(() => {
    const root = rootRef.current
    const active = root?.ownerDocument.activeElement ?? null
    // Focus the user moved elsewhere stays there; only focus the bar held goes back.
    const focusInBar =
      active === null || active === root?.ownerDocument.body || barRef.current?.contains(active)
    cancelNavigation()
    setIsOpen(false)
    if (!focusInBar || !root) {
      return
    }
    const previous = focusBeforeOpenRef.current
    focusBeforeOpenRef.current = null
    const usable =
      previous?.isConnected && root.contains(previous) && !previous.closest('[hidden], [inert]')
        ? previous
        : null
    // A shown prompt card that wants focus takes it, as it would have with the bar closed (one that
    // arrived while the bar held focus included), unless focus came from a control inside it.
    if (focusNativeChatPromptCard(root, usable)) {
      return
    }
    if (usable) {
      usable.focus({ preventScroll: true })
      return
    }
    if (!composerRef.current?.focus()) {
      root.focus({ preventScroll: true })
    }
  }, [cancelNavigation, composerRef, rootRef, setIsOpen])

  const open = useCallback(
    (returnFocusTo = rootRef.current?.ownerDocument.activeElement) => {
      // A mounted input means the bar is open: refocus it, keeping the current match.
      if (inputRef.current) {
        focusInput(inputRef.current)
        return
      }
      focusBeforeOpenRef.current = returnFocusTo instanceof HTMLElement ? returnFocusTo : null
      if (!isOpen) {
        accept(query)
      }
      requestedFocus.current = true
      setIsOpen(true)
    },
    [accept, isOpen, query, rootRef, setIsOpen]
  )

  useLayoutEffect(() => {
    if (isOpen && requestedFocus.current && inputRef.current) {
      requestedFocus.current = false
      focusInput(inputRef.current)
    }
  }, [isOpen])

  useEffect(() => {
    // Out of scope in the web client: the browser's own find keeps Mod+F there.
    if (!enabled || isWebClientLocation()) {
      return
    }
    const platform = getShortcutPlatform()
    const onKeyDown = (e: KeyboardEvent): void => {
      const root = rootRef.current
      if (e.defaultPrevented || !root || !(e.target instanceof Node) || !root.contains(e.target)) {
        return
      }
      if (!keybindingMatchesAction('chat.find', e, platform, useAppStore.getState().keybindings)) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      if (!e.repeat) {
        open()
      }
    }
    addAppKeyListener('keydown', onKeyDown)
    return () => removeAppKeyListener('keydown', onKeyDown)
  }, [enabled, open, rootRef])

  // Why React capture on the root: it runs before the composer's own onKeyDownCapture (outer
  // first), so the composer never interrupts the turn; layers that close on Escape at the
  // document (Radix popovers, the context card) still claim it earlier.
  const onKeyDownCapture = useCallback(
    (event: ReactKeyboardEvent) => {
      if (
        !isOpen ||
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        event.nativeEvent.isComposing ||
        event.keyCode === 229 ||
        ownsEscape(event.target)
      ) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      close()
    },
    [close, isOpen]
  )

  const deliver = useCallback(
    (match: Range | null, pendingOnly: boolean) => {
      const action = intent.current
      if (intent.retired || action.query !== query || (pendingOnly && !action.pending)) {
        return false
      }
      return (
        messageListRef.current?.revealFindMatch(
          match,
          barRef.current?.getBoundingClientRect() ?? null,
          () => {
            if (intent.retired || intent.current !== action || (pendingOnly && !action.pending)) {
              return false
            }
            action.pending = false
            return true
          }
        ) ?? false
      )
    },
    [intent, messageListRef, query]
  )
  const revealMatch = useCallback((match: Range) => deliver(match, false), [deliver])
  const completeSearch = useCallback(
    (match: Range | null) => !intent.current.pending || deliver(match, true),
    [deliver, intent]
  )
  const selection = useCallback(
    () => (intent.current.query === query ? intent.current.selected : null),
    [intent, query]
  )
  const selectMatch = useCallback(
    (selected: NativeChatFindLocation | null) => {
      if (!intent.retired && intent.current.query === query) {
        intent.current.selected = selected
      }
    },
    [intent, query]
  )

  return {
    isOpen,
    query,
    setQuery: changeQuery,
    close,
    open: isWebClientLocation() ? undefined : open,
    onKeyDownCapture,
    rootRef,
    barRef,
    inputRef,
    revealMatch,
    completeSearch,
    selection,
    selectMatch,
    cancelNavigation
  }
}
