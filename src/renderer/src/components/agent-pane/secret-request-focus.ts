// Where secret-request cards can show (one slot per mounted remote pane), and keyboard focus for the
// cards: one app-wide F6 handler moves focus into the card for the pane you're in and back out, and a
// card that goes away hands focus back instead of dropping it on the page.
import { useSyncExternalStore } from 'react'
import type { SecretRequestPaneSlot } from '@/lib/secret-requests/secret-request-routing'

const slots = new Map<string, SecretRequestPaneSlot>()
const slotListeners = new Set<() => void>()
let slotSnapshot: readonly SecretRequestPaneSlot[] = []

export function setSecretRequestSlot(paneKey: string, slot: SecretRequestPaneSlot | null): void {
  const current = slots.get(paneKey)
  if (slot === null) {
    if (!current) {
      return
    }
    slots.delete(paneKey)
  } else {
    if (
      current?.environmentId === slot.environmentId &&
      current.handle === slot.handle &&
      current.visible === slot.visible &&
      current.primary === slot.primary
    ) {
      return
    }
    slots.set(paneKey, slot)
  }
  slotSnapshot = [...slots.values()]
  for (const listener of slotListeners) {
    listener()
  }
}

export function useSecretRequestSlots(): readonly SecretRequestPaneSlot[] {
  return useSyncExternalStore(
    (listener) => {
      slotListeners.add(listener)
      return () => slotListeners.delete(listener)
    },
    () => slotSnapshot,
    () => slotSnapshot
  )
}

type CardRecord = {
  paneKey: string
  container: HTMLElement
  element: HTMLElement
  primary: boolean
  /** Where F6 came from, to go back to. */
  returnTo: HTMLElement | null
  hadFocus: boolean
}

const cards = new Map<string, CardRecord>()

/** The pane's terminal input, when the element focus came from is gone. */
function terminalInput(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('textarea')
}

function focusInto(record: CardRecord, from: Element | null): void {
  record.returnTo = from instanceof HTMLElement && from !== document.body ? from : null
  const target =
    record.element.querySelector<HTMLElement>('input:not([disabled]), textarea:not([disabled])') ??
    record.element.querySelector<HTMLElement>('button')
  target?.focus()
}

function focusBack(record: CardRecord): void {
  const back =
    record.returnTo && record.returnTo.isConnected
      ? record.returnTo
      : terminalInput(record.container)
  back?.focus()
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'F6' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return
  }
  const active = document.activeElement
  const all = [...cards.values()]
  const inside = all.find((record) => record.element.contains(active))
  const target =
    inside ??
    all.find((record) => active !== null && record.container.contains(active)) ??
    // From the terminal or nowhere only: inside Settings or a modal, F6 belongs to that surface.
    (active === null || active === document.body || active.closest('.xterm') !== null
      ? all.find((record) => record.primary)
      : undefined)
  if (!target) {
    return
  }
  event.preventDefault()
  event.stopImmediatePropagation()
  if (inside) {
    focusBack(inside)
  } else {
    focusInto(target, active)
  }
}

export function registerSecretRequestCard(args: {
  paneKey: string
  container: HTMLElement
  card: () => HTMLElement | null
  primary: boolean
}): () => void {
  const element = args.card()
  if (!element) {
    return () => {}
  }
  const previous = cards.get(args.paneKey)
  const record: CardRecord = {
    paneKey: args.paneKey,
    container: args.container,
    element,
    primary: args.primary,
    returnTo: previous?.element === element ? previous.returnTo : null,
    hadFocus: previous?.element === element ? previous.hadFocus : false
  }
  const onFocusIn = (): void => {
    record.hadFocus = true
  }
  const onFocusOut = (event: FocusEvent): void => {
    if (event.relatedTarget instanceof Node && !element.contains(event.relatedTarget)) {
      record.hadFocus = false
    }
  }
  element.addEventListener('focusin', onFocusIn)
  element.addEventListener('focusout', onFocusOut)
  if (cards.size === 0) {
    window.addEventListener('keydown', onKeyDown, true)
  }
  cards.set(args.paneKey, record)
  return () => {
    element.removeEventListener('focusin', onFocusIn)
    element.removeEventListener('focusout', onFocusOut)
    if (cards.get(args.paneKey) === record) {
      cards.delete(args.paneKey)
    }
    if (cards.size === 0) {
      window.removeEventListener('keydown', onKeyDown, true)
    }
    // After the commit: if the card left the page while it held focus, focus goes back, not to <body>.
    queueMicrotask(() => {
      const lost = document.activeElement === null || document.activeElement === document.body
      if (!element.isConnected && record.hadFocus && lost) {
        focusBack(record)
      }
    })
  }
}
