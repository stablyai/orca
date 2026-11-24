import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRightIcon } from 'lucide-react'
import type { Editor } from '@tiptap/react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import {
  buildRichMarkdownDomContextMenuModel,
  enabledDomMenuEntryIndices,
  initialDomMenuFocus,
  levelDomMenuEntries,
  moveDomMenuFocus,
  runRichMarkdownDomMenuEditAction,
  type RichMarkdownDomMenuCellType,
  type RichMarkdownDomMenuEntry,
  type RichMarkdownDomMenuFocus
} from './rich-markdown-dom-context-menu-model'
import {
  isRichMarkdownContextCommandTarget,
  runRichMarkdownContextCommand
} from './rich-markdown/commands/rich-markdown-context-command-routing'

// Why: Radix ContextMenu primitives need a trigger element to anchor on, but
// the menu opens at the raw cursor point inside the ProseMirror DOM. Copy the
// shadcn context-menu class strings onto plain menuitem divs instead, like the
// editor's existing floating menus (slash menu, link bubble), which are also
// manually positioned portals.
const MENU_PANEL_CLASS =
  'z-[70] min-w-[11rem] overflow-hidden rounded-[11px] border border-black/14 bg-[rgba(255,255,255,0.82)] p-[4px] text-black dark:text-white shadow-[0_12px_28px_rgba(0,0,0,0.22),inset_0_1px_0_rgba(255,255,255,0.14)] backdrop-blur-2xl dark:border-white/14 dark:bg-[rgba(0,0,0,0.72)] dark:shadow-[0_16px_34px_rgba(0,0,0,0.40),inset_0_1px_0_rgba(255,255,255,0.04)]'
const MENU_ITEM_CLASS =
  "relative flex cursor-default items-center gap-2 rounded-md px-2 py-[4px] text-[12px] leading-[17px] font-[450] outline-hidden select-none hover:bg-black/8 dark:hover:bg-white/14 hover:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[focused=true]:bg-black/8 dark:data-[focused=true]:bg-white/14 data-[focused=true]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5"
const MENU_SEPARATOR_CLASS = 'my-[3px] h-px bg-border/60'
const SUBMENU_WIDTH_ESTIMATE = 240

type DomMenuState = {
  x: number
  y: number
  cellType: RichMarkdownDomMenuCellType | null
}

export function RichMarkdownDomContextMenu({
  editor,
  rootRef,
  toggleLink,
  pickImage
}: {
  editor: Editor | null
  rootRef: { readonly current: HTMLElement | null }
  toggleLink: () => void
  pickImage: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const [menu, setMenu] = useState<DomMenuState | null>(null)
  const [openSubmenu, setOpenSubmenu] = useState<{ index: number; flip: boolean } | null>(null)
  const [focus, setFocus] = useState<RichMarkdownDomMenuFocus | null>(null)
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  // Why: the keyboard handler below reads the latest model and focus without
  // re-registering listeners, the same ref-forward pattern RichMarkdownEditor
  // uses for its toolbar callbacks.
  const dispatchEntryRef = useRef<(entry: RichMarkdownDomMenuEntry) => void>(() => {})

  useEffect(() => {
    if (!editor) {
      return
    }
    const dom = editor.view.dom
    const onContextMenu = (event: MouseEvent): void => {
      if (!editor.isEditable) {
        return
      }
      // Why: WebView2 shows its own default menu otherwise; Electron never
      // reaches this component because the native menu handles it there.
      event.preventDefault()
      const target = event.target instanceof Element ? event.target.closest('td, th') : null
      const cell = target && dom.contains(target) ? target : null
      const cellType = cell ? (cell.tagName === 'TH' ? 'header' : 'body') : null
      setOpenSubmenu(null)
      setPosition(null)
      setFocus(
        initialDomMenuFocus(
          buildRichMarkdownDomContextMenuModel({
            cellType,
            hasSelection: !editor.state.selection.empty,
            t
          })
        )
      )
      setMenu({
        x: event.clientX,
        y: event.clientY,
        cellType
      })
    }
    dom.addEventListener('contextmenu', onContextMenu)
    return () => {
      dom.removeEventListener('contextmenu', onContextMenu)
    }
  }, [editor, t])

  useEffect(() => {
    if (!menu) {
      return
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && panelRef.current?.contains(event.target)) {
        return
      }
      setMenu(null)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      const model = buildRichMarkdownDomContextMenuModel({
        cellType: menu.cellType,
        hasSelection: editor?.state.selection.empty === false,
        t
      })
      const openSubmenuEntries =
        openSubmenu === null ? null : levelDomMenuEntries(model, openSubmenu.index, true)
      const activateFocused = (): void => {
        const entries = focus?.inSubmenu === true && openSubmenuEntries ? openSubmenuEntries : model
        const entry = focus ? entries[focus.index] : undefined
        if (!entry || entry.kind === 'separator') {
          return
        }
        if (entry.kind === 'submenu') {
          openFocusedSubmenu()
          return
        }
        if (entry.disabled === true) {
          return
        }
        dispatchEntryRef.current(entry)
      }
      const openFocusedSubmenu = (): void => {
        if (!focus || focus.inSubmenu) {
          return
        }
        const entry = model[focus.index]
        if (entry?.kind !== 'submenu' || openSubmenu?.index === focus.index) {
          return
        }
        const panelRight = panelRef.current?.getBoundingClientRect().right ?? menu.x
        setOpenSubmenu({
          index: focus.index,
          flip: panelRight + SUBMENU_WIDTH_ESTIMATE > window.innerWidth
        })
        const next = initialDomMenuFocus(entry.items)
        setFocus(next ? { inSubmenu: true, index: next.index } : null)
      }
      const jumpToEdge = (edge: 'first' | 'last'): void => {
        const inSubmenu = focus?.inSubmenu === true
        const entries = levelDomMenuEntries(model, openSubmenu?.index ?? null, inSubmenu)
        const enabled = enabledDomMenuEntryIndices(entries)
        const target = edge === 'first' ? enabled.at(0) : enabled.at(-1)
        if (target !== undefined) {
          setFocus({ inSubmenu, index: target })
        }
      }
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault()
          setFocus((current) =>
            moveDomMenuFocus({
              model,
              openSubmenuIndex: openSubmenu?.index ?? null,
              focus: current,
              direction: 1
            })
          )
          return
        case 'ArrowUp':
          event.preventDefault()
          setFocus((current) =>
            moveDomMenuFocus({
              model,
              openSubmenuIndex: openSubmenu?.index ?? null,
              focus: current,
              direction: -1
            })
          )
          return
        case 'ArrowRight':
          event.preventDefault()
          openFocusedSubmenu()
          return
        case 'ArrowLeft':
          event.preventDefault()
          if (focus?.inSubmenu === true && openSubmenu) {
            setOpenSubmenu(null)
            setFocus({ inSubmenu: false, index: openSubmenu.index })
          }
          return
        case 'Home':
          event.preventDefault()
          jumpToEdge('first')
          return
        case 'End':
          event.preventDefault()
          jumpToEdge('last')
          return
        case 'Enter':
        case ' ':
          event.preventDefault()
          activateFocused()
          return
        case 'Tab':
          setMenu(null)
          return
        case 'Escape':
          if (focus?.inSubmenu === true && openSubmenu) {
            setOpenSubmenu(null)
            setFocus({ inSubmenu: false, index: openSubmenu.index })
            return
          }
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
  }, [menu, editor, openSubmenu, focus, t])

  useLayoutEffect(() => {
    if (!menu || !panelRef.current) {
      return
    }
    // Why: the body portal escapes editor clipping, so clamp the measured
    // panel into the viewport like the link bubble does.
    const rect = panelRef.current.getBoundingClientRect()
    setPosition({
      x: Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8)),
      y: Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8))
    })
  }, [menu])

  const dispatchEntry = (entry: RichMarkdownDomMenuEntry): void => {
    // Why: listeners fire only while the menu is open, but the ref assignment
    // below runs before the early return narrows editor and menu.
    if (!editor || !menu) {
      return
    }
    if (entry.kind === 'edit') {
      runRichMarkdownDomMenuEditAction(editor, entry.action)
      setMenu(null)
      return
    }
    if (entry.kind !== 'command') {
      return
    }
    const payload = { command: entry.command, x: menu.x, y: menu.y }
    if (!isRichMarkdownContextCommandTarget(payload, rootRef.current)) {
      setMenu(null)
      return
    }
    runRichMarkdownContextCommand({ payload, editor, toggleLink, pickImage })
    setMenu(null)
  }

  // Why: the keyboard handler above calls through the ref so it always reaches the latest closure.
  useEffect(() => {
    dispatchEntryRef.current = dispatchEntry
  })

  if (!editor || !menu) {
    return null
  }

  const panelPosition: React.CSSProperties = {
    left: position?.x ?? menu.x,
    top: position?.y ?? menu.y
  }

  const model = buildRichMarkdownDomContextMenuModel({
    cellType: menu.cellType,
    hasSelection: !editor.state.selection.empty,
    t
  })

  const renderEntries = (
    entries: RichMarkdownDomMenuEntry[],
    inSubmenu: boolean
  ): React.JSX.Element[] =>
    entries.map((entry, index) => {
      const key = `${inSubmenu ? 'sub' : 'root'}:${index}`
      const focused = focus?.inSubmenu === inSubmenu && focus?.index === index
      if (entry.kind === 'separator') {
        return <div key={key} role="separator" className={MENU_SEPARATOR_CLASS} />
      }
      if (entry.kind === 'submenu') {
        // Why: the Electron template nests only one submenu level, so an open
        // submenu always belongs to the top level and children never recurse.
        const open = !inSubmenu && openSubmenu?.index === index
        // Why: spread a CSSProperties-typed offset like components/ui/context-menu
        // does so the Electron-only drag-region opt-out compiles the same way.
        const submenuOffset: React.CSSProperties =
          openSubmenu?.flip === true ? { right: 'calc(100% - 2px)' } : { left: 'calc(100% - 2px)' }
        const openSubmenuAt = (flip: boolean): void => {
          setOpenSubmenu({ index, flip })
          const next = initialDomMenuFocus(entry.items)
          setFocus(next ? { inSubmenu: true, index: next.index } : { inSubmenu: false, index })
        }
        return (
          <div
            key={key}
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open}
            data-submenu={entry.label}
            data-focused={focused ? 'true' : undefined}
            className={cn(MENU_ITEM_CLASS, 'justify-between')}
            onMouseEnter={(event) => {
              const rect = event.currentTarget.getBoundingClientRect()
              setOpenSubmenu({
                index,
                flip: rect.right + SUBMENU_WIDTH_ESTIMATE > window.innerWidth
              })
              setFocus({ inSubmenu: false, index })
            }}
            onClick={() => openSubmenuAt(false)}
          >
            <span>{entry.label}</span>
            <ChevronRightIcon />
            {open && (
              <div
                role="menu"
                aria-label={entry.label}
                className={cn(MENU_PANEL_CLASS, 'absolute top-[-4px]')}
                // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: WebkitAppRegion is Electron's drag-region hint and absent from csstype, like the shadcn context-menu primitive this mirrors.
                style={{ ...submenuOffset, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              >
                {renderEntries(entry.items, true)}
              </div>
            )}
          </div>
        )
      }
      return (
        <div
          key={key}
          role="menuitem"
          data-command={entry.kind === 'command' ? entry.command : undefined}
          data-edit={entry.kind === 'edit' ? entry.action : undefined}
          data-disabled={entry.disabled === true ? 'true' : undefined}
          data-focused={focused ? 'true' : undefined}
          aria-disabled={entry.disabled === true}
          className={MENU_ITEM_CLASS}
          onMouseEnter={() => {
            if (!inSubmenu) {
              setOpenSubmenu(null)
            }
            setFocus({ inSubmenu, index })
          }}
          onClick={() => {
            if (entry.disabled === true) {
              return
            }
            dispatchEntry(entry)
          }}
        >
          <span>{entry.label}</span>
        </div>
      )
    })

  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      aria-label={t(
        'auto.components.editor.RichMarkdownDomContextMenu.menuLabel',
        'Markdown editing'
      )}
      data-testid="rich-markdown-dom-context-menu"
      className={cn(MENU_PANEL_CLASS, 'fixed')}
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: WebkitAppRegion is Electron's drag-region hint and absent from csstype, like the shadcn context-menu primitive this mirrors.
      style={{ ...panelPosition, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      onMouseLeave={() => setOpenSubmenu(null)}
    >
      {renderEntries(model, false)}
    </div>,
    document.body
  )
}
