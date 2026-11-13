import { useCallback, useLayoutEffect, useRef, type RefCallback } from 'react'

export const SETTINGS_TARGET_HIGHLIGHT_CLASS_NAME = 'settings-target-highlight'

const SETTINGS_TITLE_TARGET_PREFIX = 'settings-title:'

// Search entries without an anchor id target their rendered row by title.
export function getSettingsTitleTargetId(title: string): string {
  return `${SETTINGS_TITLE_TARGET_PREFIX}${title}`
}

export function parseSettingsTitleTargetId(targetId: string): string | null {
  return targetId.startsWith(SETTINGS_TITLE_TARGET_PREFIX)
    ? targetId.slice(SETTINGS_TITLE_TARGET_PREFIX.length)
    : null
}

const SETTINGS_GROUP_CARD_SELECTOR = '[data-settings-group-card]'

// Rows sit at different insets (nested rows, sub-fields), so measure the gap from the row to
// its card's inner edges instead of assuming one gutter.
function findEnclosingSettingsCard(element: HTMLElement): HTMLElement | null {
  const groupCard = element.parentElement?.closest<HTMLElement>(SETTINGS_GROUP_CARD_SELECTOR)
  if (groupCard) {
    return groupCard
  }
  for (let node = element.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (
      Number.parseFloat(style.borderLeftWidth) > 0 &&
      Number.parseFloat(style.borderTopLeftRadius) >= 8
    ) {
      return node
    }
  }
  return null
}

// An anchor on a whole section (title plus card) tints only its card, so the tint keeps the card's corners.
export function resolveSettingsHighlightElement(target: HTMLElement): HTMLElement {
  if (target.matches(SETTINGS_GROUP_CARD_SELECTOR) || findEnclosingSettingsCard(target)) {
    return target
  }
  return target.querySelector<HTMLElement>(SETTINGS_GROUP_CARD_SELECTOR) ?? target
}

export function applySettingsTargetHighlightBleed(target: HTMLElement): void {
  const card = findEnclosingSettingsCard(target)
  if (!card) {
    return
  }
  const cardRect = card.getBoundingClientRect()
  const cardStyle = getComputedStyle(card)
  const targetRect = target.getBoundingClientRect()
  const left = targetRect.left - cardRect.left - Number.parseFloat(cardStyle.borderLeftWidth)
  const right = cardRect.right - Number.parseFloat(cardStyle.borderRightWidth) - targetRect.right
  target.style.setProperty('--settings-target-bleed-left', `${Math.max(0, left)}px`)
  target.style.setProperty('--settings-target-bleed-right', `${Math.max(0, right)}px`)
}

export function clearSettingsTargetHighlightBleed(target: HTMLElement): void {
  target.style.removeProperty('--settings-target-bleed-left')
  target.style.removeProperty('--settings-target-bleed-right')
}

const SETTINGS_TARGET_REVEAL_EVENT = 'orca-settings-target-reveal'

// Collapsed sections keep their rows mounted but hidden; the jump asks each one around the target to open.
export function requestSettingsTargetReveal(target: HTMLElement): void {
  target.dispatchEvent(new Event(SETTINGS_TARGET_REVEAL_EVENT, { bubbles: true }))
}

// A ref callback, so a disclosure that mounts later (or remounts) still gets the listener.
export function useSettingsTargetReveal<T extends HTMLElement>(
  onReveal: () => void
): RefCallback<T> {
  const onRevealRef = useRef(onReveal)
  useLayoutEffect(() => {
    onRevealRef.current = onReveal
  })
  return useCallback((node: T | null) => {
    if (!node) {
      return
    }
    const listener = (): void => onRevealRef.current()
    node.addEventListener(SETTINGS_TARGET_REVEAL_EVENT, listener)
    return () => node.removeEventListener(SETTINGS_TARGET_REVEAL_EVENT, listener)
  }, [])
}
