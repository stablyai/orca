import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '@/i18n/use-translate'
import {
  buildPlainEditableDomContextMenuModel,
  findPlainEditableContextMenuTarget,
  initialPlainEditableDomMenuFocus,
  movePlainEditableDomMenuFocus,
  readPlainEditableTargetState,
  runPlainEditableDomMenuEditAction,
  shouldUsePlainEditableDomContextMenu,
  type PlainEditableDomMenuAction,
  type PlainEditableDomMenuEntry
} from './plain-editable-dom-context-menu-model'

// Why: same chrome as the rich-markdown DOM menu so the two transport
// replacements read as one menu; the strings stay static literals so the
// design-system gate keeps passing.
const MENU_PANEL_CLASS =
  'z-[70] min-w-[11rem] overflow-hidden rounded-[11px] border border-black/14 bg-[rgba(255,255,255,0.82)] p-[4px] text-black dark:text-white shadow-[0_12px_28px_rgba(0,0,0,0.22),inset_0_1px_0_rgba(255,255,255,0.14)] backdrop-blur-2xl dark:border-white/14 dark:bg-[rgba(0,0,0,0.72)] dark:shadow-[0_16px_34px_rgba(0,0,0,0.40),inset_0_1px_0_rgba(255,255,255,0.04)]'
const MENU_ITEM_CLASS =
  "relative flex cursor-default items-center gap-2 rounded-md px-2 py-[4px] text-[12px] leading-[17px] font-[450] outline-hidden select-none hover:bg-black/8 dark:hover:bg-white/14 hover:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[focused=true]:bg-black/8 dark:data-[focused=true]:bg-white/14 data-[focused=true]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5"

type PlainMenuState = {
  x: number
  y: number
}

// Why: one host for the whole renderer. It listens on bubble phase so
// surfaces that own their menu (rich markdown, native chat, terminal) run
// first and claim the event with preventDefault before this host sees it.
export function PlainEditableDomContextMenuHost(): React.JSX.Element | null {
  const t = useTranslate()
  const [menu, setMenu] = useState<PlainMenuState | null>(null)
  const [menuTarget, setMenuTarget] = useState<HTMLElement | null>(null)
  const [focus, setFocus] = useState<number | null>(null)
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const targetRef = useRef<HTMLElement | null>(null)
  const dispatchActionRef = useRef<(action: PlainEditableDomMenuAction) => void>(() => {})

  useEffect(() => {
    if (!shouldUsePlainEditableDomContextMenu()) {
      return
    }
    const onContextMenu = (event: MouseEvent): void => {
      // Why: another surface owned this press, or this is not a Tauri/web
      // surface at all; WebView2 shows its own default menu otherwise.
      if (event.defaultPrevented) {
        return
      }
      const target = findPlainEditableContextMenuTarget(event.target)
      if (!target) {
        return
      }
      event.preventDefault()
      targetRef.current = target
      setMenuTarget(target)
      const { hasSelection, readOnly } = readPlainEditableTargetState(target)
      setFocus(
        initialPlainEditableDomMenuFocus(
          buildPlainEditableDomContextMenuModel({ hasSelection, readOnly, t })
        )
      )
      setPosition(null)
      setMenu({ x: event.clientX, y: event.clientY })
    }
    window.addEventListener('contextmenu', onContextMenu)
    return () => {
      window.removeEventListener('contextmenu', onContextMenu)
    }
  }, [t])

  useEffect(() => {
    if (!menu) {
      return
    }
    const stateOf = (): { model: PlainEditableDomMenuEntry[] } => {
      const target = targetRef.current
      const { hasSelection, readOnly } = target
        ? readPlainEditableTargetState(target)
        : { hasSelection: false, readOnly: false }
      return { model: buildPlainEditableDomContextMenuModel({ hasSelection, readOnly, t }) }
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && panelRef.current?.contains(event.target)) {
        return
      }
      setMenu(null)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      const { model } = stateOf()
      const activateFocused = (): void => {
        const entry = focus === null ? undefined : model[focus]
        if (!entry || entry.kind === 'separator' || entry.disabled === true) {
          return
        }
        dispatchActionRef.current(entry.action)
      }
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault()
          setFocus((current) =>
            movePlainEditableDomMenuFocus({ entries: model, focus: current, direction: 1 })
          )
          return
        case 'ArrowUp':
          event.preventDefault()
          setFocus((current) =>
            movePlainEditableDomMenuFocus({ entries: model, focus: current, direction: -1 })
          )
          return
        case 'Home':
          event.preventDefault()
          setFocus(initialPlainEditableDomMenuFocus(model))
          return
        case 'End': {
          event.preventDefault()
          const enabled: number[] = []
          for (let index = 0; index < model.length; index++) {
            const entry = model[index]
            if (entry.kind !== 'separator' && entry.disabled !== true) {
              enabled.push(index)
            }
          }
          setFocus(enabled.at(-1) ?? null)
          return
        }
        case 'Enter':
        case ' ':
          event.preventDefault()
          activateFocused()
          return
        case 'Tab':
        case 'Escape':
          setMenu(null)
      }
    }
    const close = (): void => setMenu(null)
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
    }
  }, [menu, focus, t])

  useLayoutEffect(() => {
    if (!menu || !panelRef.current) {
      return
    }
    // Why: the body portal escapes clipping ancestors, so clamp the measured
    // panel into the viewport like the rich-markdown DOM menu does.
    const rect = panelRef.current.getBoundingClientRect()
    setPosition({
      x: Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8)),
      y: Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8))
    })
  }, [menu])

  const dispatchAction = (action: PlainEditableDomMenuAction): void => {
    const target = targetRef.current
    if (!target || !target.isConnected) {
      setMenu(null)
      return
    }
    runPlainEditableDomMenuEditAction(target, action)
    setMenu(null)
  }

  // Why: the listeners above call through the ref so they always reach the latest closure.
  useEffect(() => {
    dispatchActionRef.current = dispatchAction
  })

  if (!menu) {
    return null
  }

  // Why: render reads the state mirror; the ref is only for listeners and callbacks.
  const target = menuTarget
  const { hasSelection, readOnly } = target
    ? readPlainEditableTargetState(target)
    : { hasSelection: false, readOnly: false }
  const model = buildPlainEditableDomContextMenuModel({ hasSelection, readOnly, t })

  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      aria-label={t('auto.components.editor.PlainEditableDomContextMenu.menuLabel', 'Edit')}
      data-testid="plain-editable-dom-context-menu"
      className={MENU_PANEL_CLASS}
      style={{
        position: 'fixed',
        left: position?.x ?? menu.x,
        top: position?.y ?? menu.y
      }}
    >
      {model.map((entry, index) => {
        if (entry.kind === 'separator') {
          return <div key={`sep:${index}`} role="separator" />
        }
        const focused = focus === index
        return (
          <div
            key={entry.action}
            role="menuitem"
            data-edit={entry.action}
            data-disabled={entry.disabled === true ? 'true' : undefined}
            data-focused={focused ? 'true' : undefined}
            aria-disabled={entry.disabled === true}
            className={MENU_ITEM_CLASS}
            onMouseEnter={() => setFocus(index)}
            onClick={() => {
              if (entry.disabled !== true) {
                dispatchAction(entry.action)
              }
            }}
          >
            <span>{entry.label}</span>
          </div>
        )
      })}
    </div>,
    document.body
  )
}
