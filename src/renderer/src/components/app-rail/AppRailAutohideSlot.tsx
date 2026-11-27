import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store/index'
import { requestAppRailMenu } from './app-rail-menu-request'
import {
  APP_RAIL_EDGE_ZONE_PX,
  APP_RAIL_FIRST_RUN_DOCKED_MS,
  APP_RAIL_FIRST_RUN_LINGER_MS,
  APP_RAIL_HIDE_DELAY_MS,
  APP_RAIL_REVEAL_DELAY_MS,
  consumeAppRailFirstRunReplay,
  readAppRailAutohideVariant,
  type AppRailAutohideVariant
} from './app-rail-autohide'

/**
 * The rail's slot in the left column. Docked ("always", and the first-run intro) it takes its width as before; in hover
 * mode the slot is 0px (3px for the sliver) and the rail is an overlay that slides in over the list and content, so
 * nothing beside it resizes and no terminal reflows on reveal.
 */
export function AppRailAutohideSlot({
  headerSpacer,
  children
}: {
  /** The left titlebar covers this gap so the traffic-light row spans rail and list. */
  headerSpacer: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const visibility = useAppStore((s) => s.settings?.appRailVisibility)
  const [firstRun, setFirstRun] = useState(
    () => consumeAppRailFirstRunReplay() || visibility === undefined
  )
  const docked = visibility === 'always' || firstRun
  const [open, setOpenState] = useState(false)
  const openRef = useRef(false)
  const [variant, setVariant] = useState<AppRailAutohideVariant>(readAppRailAutohideVariant)
  const [cue, setCue] = useState(false)
  const slotRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // One-shot: the first hide after the intro lingers a little and plays the edge glow.
  const introRef = useRef(false)

  const setOpen = useCallback((next: boolean): void => {
    if (openRef.current === next) {
      return
    }
    openRef.current = next
    if (next) {
      // Dev-only variant switch: read on each reveal so a console change applies without a reload.
      setVariant(readAppRailAutohideVariant())
    } else if (introRef.current) {
      introRef.current = false
      setCue(true)
    }
    setOpenState(next)
  }, [])

  useEffect(() => {
    if (!cue) {
      return
    }
    const timer = window.setTimeout(() => setCue(false), 1600)
    return () => window.clearTimeout(timer)
  }, [cue])

  // First launch after the update: show the rail docked, then slide it away once so people see where it went.
  useEffect(() => {
    if (!firstRun) {
      return
    }
    const timer = window.setTimeout(() => {
      introRef.current = true
      setFirstRun(false)
      const state = useAppStore.getState()
      if (state.settings?.appRailVisibility === undefined) {
        void state.updateSettings({ appRailVisibility: 'hover' })
      }
    }, APP_RAIL_FIRST_RUN_DOCKED_MS)
    return () => window.clearTimeout(timer)
  }, [firstRun])

  // Leaving "always": the content slides left under the rail, which stays until the pointer leaves it.
  const prevDockedRef = useRef(docked)
  useLayoutEffect(() => {
    if (prevDockedRef.current && !docked) {
      setOpen(true)
    } else if (docked) {
      openRef.current = false
      setOpenState(false)
    }
    prevDockedRef.current = docked
  }, [docked, setOpen])

  useEffect(() => {
    const slot = slotRef.current
    const panel = panelRef.current
    if (docked || !slot || !panel) {
      return
    }
    let showTimer = 0
    let hideTimer = 0
    let overPanel = panel.matches(':hover')
    let inZone = false
    let pressed = false
    const clearShow = (): void => {
      window.clearTimeout(showTimer)
      showTimer = 0
    }
    const clearHide = (): void => {
      window.clearTimeout(hideTimer)
      hideTimer = 0
    }
    const menuOpen = (): boolean =>
      panel.querySelector('[aria-haspopup="menu"][aria-expanded="true"]') !== null
    // Mouse clicks focus rail buttons too; only keyboard focus (focus-visible) holds the rail open.
    const held = (): boolean => menuOpen() || panel.querySelector(':focus-visible') !== null
    // Below the title bar, so the traffic lights and the titlebar drag area never reveal the rail.
    let headerHeight: number | null = null
    const zoneTop = (): number => {
      if (headerHeight === null) {
        headerHeight = headerSpacer
          ? Number.parseFloat(getComputedStyle(slot).getPropertyValue('--app-header-height')) || 0
          : 0
      }
      return slot.getBoundingClientRect().top + headerHeight
    }
    const reveal = (): void => {
      clearHide()
      if (openRef.current || showTimer) {
        return
      }
      showTimer = window.setTimeout(() => {
        showTimer = 0
        setOpen(true)
      }, APP_RAIL_REVEAL_DELAY_MS)
    }
    const conceal = (delay = APP_RAIL_HIDE_DELAY_MS): void => {
      clearShow()
      if (!openRef.current || hideTimer) {
        return
      }
      hideTimer = window.setTimeout(() => {
        hideTimer = 0
        if (!overPanel && !inZone && !held()) {
          setOpen(false)
        }
      }, delay)
    }
    const evaluate = (): void => {
      if (!openRef.current) {
        if (inZone && !pressed) {
          reveal()
        } else {
          clearShow()
        }
        return
      }
      if (overPanel || inZone || held()) {
        clearHide()
      } else {
        conceal(introRef.current ? APP_RAIL_FIRST_RUN_LINGER_MS : APP_RAIL_HIDE_DELAY_MS)
      }
    }
    // Cheap path first: most moves are far from the edge and never touch layout.
    const updateZone = (x: number, y: number): void => {
      inZone = x < APP_RAIL_EDGE_ZONE_PX && y >= zoneTop()
    }
    const onPointerMove = (event: PointerEvent): void => {
      const wasInZone = inZone
      if (event.clientX < APP_RAIL_EDGE_ZONE_PX) {
        updateZone(event.clientX, event.clientY)
      } else {
        inZone = false
      }
      pressed = event.buttons !== 0
      if (wasInZone !== inZone || (!openRef.current && inZone) || pressed) {
        evaluate()
      }
    }
    // A press in the zone is a window-edge resize or a click on the list, never a reveal.
    const onPointerDown = (): void => {
      pressed = true
      if (!openRef.current) {
        clearShow()
      }
    }
    const onPointerUp = (): void => {
      pressed = false
    }
    const onPanelEnter = (): void => {
      overPanel = true
      evaluate()
    }
    const onPanelLeave = (): void => {
      overPanel = false
      evaluate()
    }
    const onWindowLeave = (): void => {
      inZone = false
      overPanel = false
      clearShow()
      evaluate()
    }
    const onBlur = (): void => {
      clearShow()
      clearHide()
      if (!menuOpen()) {
        setOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !openRef.current || menuOpen()) {
        return
      }
      clearShow()
      clearHide()
      const active = document.activeElement
      if (active instanceof HTMLElement && panel.contains(active)) {
        active.blur()
      }
      setOpen(false)
    }
    const onFocusIn = (): void => {
      clearShow()
      clearHide()
      setOpen(true)
    }
    const onFocusOut = (): void => {
      // After the focus move settles, so a hop between rail buttons or into a menu keeps it open.
      window.setTimeout(evaluate, 0)
    }
    // Drags suppress pointer events; dragging a file or tab to the edge still reveals, so rail pages stay drop targets.
    const onDragOver = (event: DragEvent): void => {
      updateZone(event.clientX, event.clientY)
      if (openRef.current) {
        const rect = panel.getBoundingClientRect()
        overPanel =
          event.clientX >= rect.left &&
          event.clientX <= rect.right &&
          event.clientY >= rect.top &&
          event.clientY <= rect.bottom
      }
      pressed = false
      evaluate()
    }
    const onDragEnd = (): void => {
      inZone = false
      overPanel = panel.matches(':hover')
      evaluate()
    }
    const observer = new MutationObserver(evaluate)
    observer.observe(panel, { subtree: true, attributes: true, attributeFilter: ['aria-expanded'] })

    const root = document.documentElement
    window.addEventListener('pointermove', onPointerMove, { passive: true })
    window.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true })
    window.addEventListener('pointerup', onPointerUp, { capture: true, passive: true })
    window.addEventListener('blur', onBlur)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('dragover', onDragOver, { passive: true })
    window.addEventListener('dragend', onDragEnd)
    window.addEventListener('drop', onDragEnd)
    root.addEventListener('mouseleave', onWindowLeave)
    panel.addEventListener('pointerenter', onPanelEnter)
    panel.addEventListener('pointerleave', onPanelLeave)
    panel.addEventListener('focusin', onFocusIn)
    panel.addEventListener('focusout', onFocusOut)
    evaluate()
    return () => {
      clearShow()
      clearHide()
      observer.disconnect()
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerdown', onPointerDown, { capture: true })
      window.removeEventListener('pointerup', onPointerUp, { capture: true })
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragend', onDragEnd)
      window.removeEventListener('drop', onDragEnd)
      root.removeEventListener('mouseleave', onWindowLeave)
      panel.removeEventListener('pointerenter', onPanelEnter)
      panel.removeEventListener('pointerleave', onPanelLeave)
      panel.removeEventListener('focusin', onFocusIn)
      panel.removeEventListener('focusout', onFocusOut)
    }
  }, [docked, headerSpacer, setOpen])

  return (
    <div
      ref={slotRef}
      className="app-rail-slot relative flex min-h-0 shrink-0 flex-col"
      data-docked={docked ? '' : undefined}
      data-open={!docked && open ? '' : undefined}
      data-variant={variant}
      style={
        {
          '--app-rail-top': headerSpacer ? 'var(--app-header-height)' : '0px'
        } as React.CSSProperties
      }
    >
      <div
        ref={panelRef}
        className="app-rail-panel"
        onContextMenu={(event) => {
          event.preventDefault()
          requestAppRailMenu()
        }}
      >
        {headerSpacer ? <div className="app-rail-panel-spacer shrink-0" /> : null}
        {children}
      </div>
      {cue ? <div className="app-rail-edge-cue" aria-hidden /> : null}
    </div>
  )
}
