import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject
} from 'react'
import { keybindingMatchesAction } from '../../../../shared/keybindings'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { isEditableTarget } from '@/lib/editable-target'
import { isWebClientLocation } from '@/lib/web-client-location'
import { useAppStore } from '../../store'
import type { NativeChatComposerHandle } from './native-chat-composer-types'
import type { NativeChatMessageListHandle } from './use-native-chat-reveal-latest'
import { focusNativeChatPromptCard } from './use-native-chat-prompt-card-focus'

/** The chat's find: open state and query live with the chat, so a reopen keeps the last query. */
export type NativeChatFind = {
  isOpen: boolean
  query: string
  setQuery: (query: string) => void
  close: () => void
  /** For the chat root's onKeyDownCapture: an Escape while open closes the bar. */
  onKeyDownCapture: (event: ReactKeyboardEvent) => void
  rootRef: RefObject<HTMLDivElement | null>
  barRef: RefObject<HTMLDivElement | null>
  inputRef: RefObject<HTMLInputElement | null>
  /** Brings a match into the transcript's view, clear of the bar, as a reader step would. */
  revealMatch: (match: Range) => void
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
  messageListRef: RefObject<Pick<NativeChatMessageListHandle, 'revealFindMatch'> | null>
): NativeChatFind {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const barRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const focusBeforeOpenRef = useRef<HTMLElement | null>(null)

  const close = useCallback(() => {
    const root = rootRef.current
    const active = root?.ownerDocument.activeElement ?? null
    // Focus the user moved elsewhere stays there; only focus the bar held goes back.
    const focusInBar =
      active === null || active === root?.ownerDocument.body || barRef.current?.contains(active)
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
  }, [composerRef, rootRef])

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
      if (e.repeat) {
        return
      }
      // A mounted input means the bar is open: refocus it, keeping the current match.
      if (inputRef.current) {
        focusInput(inputRef.current)
        return
      }
      const active = root.ownerDocument.activeElement
      focusBeforeOpenRef.current = active instanceof HTMLElement ? active : null
      setIsOpen(true)
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [enabled, rootRef])

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

  const revealMatch = useCallback(
    (match: Range) =>
      messageListRef.current?.revealFindMatch(
        match,
        barRef.current?.getBoundingClientRect() ?? null
      ),
    [messageListRef]
  )

  return {
    isOpen,
    query,
    setQuery,
    close,
    onKeyDownCapture,
    rootRef,
    barRef,
    inputRef,
    revealMatch
  }
}
