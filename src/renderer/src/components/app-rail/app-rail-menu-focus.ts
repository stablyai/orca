import type React from 'react'
import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'

export type AppRailCustomizeRow = {
  id: string
  label: string
  icon: React.ReactNode
  shown: boolean
  onToggle: () => void
}

/**
 * Keep an open menu where it opened while its anchor moves (a toggle adds or removes a slot above "…", or a row above
 * More's Customize), so the next click lands on the row it aims at. Reopening anchors afresh. `moveKey` changes on
 * every render that can move the anchor.
 */
export function useMenuHeldInPlace(
  open: boolean,
  anchorRef: React.RefObject<HTMLElement | null>,
  moveKey: unknown
): { alignOffset: number; sticky: 'always' } {
  const openedTopRef = useRef<number | null>(null)
  const [alignOffset, setAlignOffset] = useState(0)
  useLayoutEffect(() => {
    openedTopRef.current = open ? (anchorRef.current?.getBoundingClientRect().top ?? null) : null
    setAlignOffset(0)
  }, [open, anchorRef])
  useLayoutEffect(() => {
    const openedTop = openedTopRef.current
    if (openedTop === null) {
      return
    }
    const top = anchorRef.current?.getBoundingClientRect().top
    if (top !== undefined) {
      setAlignOffset(openedTop - top)
    }
  }, [moveKey, anchorRef])
  // Radix's default "partial" stickiness would pull the menu back to touch the moved anchor.
  return { alignOffset, sticky: 'always' }
}

/**
 * Radix leaves focus where an outside click put it, which is the body when the click lands on blank space; hand it back
 * to the menu's trigger then. Checked a frame later, after the dismissing click's own focus change.
 */
export function refocusTriggerIfFocusLost(trigger: HTMLElement | null): void {
  requestAnimationFrame(() => {
    const active = document.activeElement
    if ((!active || active === document.body || !active.isConnected) && trigger?.isConnected) {
      trigger.focus({ preventScroll: true })
    }
  })
}

export function useAppRailCustomizeLabel(): string {
  const t = useTranslate()
  return t('appRail.customize', 'Customize')
}
