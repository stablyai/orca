import React, { useEffect, useRef, useState } from 'react'
import { Settings } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { cn } from '@/lib/class-names'
import { formatOptionalPrimaryShortcutLabel } from '@/hooks/useShortcutLabel'
import {
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  useDropdownMenuClose
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  arrangeNewTabMenuItems,
  buildNewTabMenuLayout,
  type NewTabMenuLayout
} from '../../../../shared/new-tab-menu/new-tab-menu-layout'
import type { KeybindingActionId } from '../../../../shared/keybindings/types'
import type { TabBarCreateRowItem } from './tab-bar-create-row-item'
import { TabBarCreateRowCustomizer } from './TabBarCreateRowCustomizer'
import { TabStripScrollIndicator } from './TabStripScrollIndicator'
import { getTabStripScrollMaskClassName } from './tab-strip-scroll-metrics'
import { useCreateRowScroller } from './use-create-row-scroller'

const EMPTY_LAYOUT: NewTabMenuLayout = { order: [], hidden: [] }

/**
 * The + menu's create actions as one row of icons that scrolls sideways when it overflows,
 * ending in a gear that opens a submenu to reorder, hide, and assign shortcuts to them.
 * ←/→ walk the icons and the gear.
 */
export function TabBarCreateRow({
  items,
  customizable,
  renderBelow
}: {
  items: readonly TabBarCreateRowItem[]
  customizable: boolean
  /** Content tied to shown items, e.g. an intro for an icon the user has not hidden. */
  renderBelow?: (shownIds: ReadonlySet<string>) => React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const closeMenu = useDropdownMenuClose()
  const keybindings = useAppStore((state) => state.keybindings)
  const savedLayout = useAppStore((state) => state.settings?.newTabMenuLayout)
  const updateSettings = useAppStore((state) => state.updateSettings)
  // Why: settings persist asynchronously; show a drop where it landed instead of snapping back.
  const [pendingLayout, setPendingLayout] = useState<NewTabMenuLayout | null>(null)
  const layout = pendingLayout ?? savedLayout
  const arranged = arrangeNewTabMenuItems(items, customizable ? layout : undefined)
  // A turned-off feature is never in the row; it waits under Hidden until shown again.
  const visible = arranged.visible.filter((item) => !item.enable)
  const hidden = [...arranged.hidden, ...arranged.visible.filter((item) => item.enable)]
  const [activeIndex, setActiveIndex] = useState(0)
  const [rowFocused, setRowFocused] = useState(false)
  // Why: the active-icon highlight is a keyboard cursor; pointer users get plain hover.
  const [keyboardNav, setKeyboardNav] = useState(false)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const pointerInside = useRef(false)
  const scroller = useCreateRowScroller()
  const [recordingActionId, setRecordingActionId] = useState<KeybindingActionId | null>(null)
  const customizeIndex = visible.length
  const active = Math.min(activeIndex, customizeIndex)
  const keyboardActive = rowFocused && keyboardNav
  const below = renderBelow?.(new Set(visible.map((item) => item.id)))

  // Suspend global shortcuts so recorded chords reach the recorder.
  useEffect(() => {
    if (recordingActionId === null) {
      return
    }
    window.api.ui.setShortcutRecorderFocused(true)
    return () => window.api.ui.setShortcutRecorderFocused(false)
  }, [recordingActionId])

  const run = (item: TabBarCreateRowItem): void => {
    item.run()
    closeMenu()
  }
  const shortcutFor = (item: TabBarCreateRowItem): string | null =>
    item.actionId ? formatOptionalPrimaryShortcutLabel(item.actionId, keybindings) : null

  if (!customizable) {
    return (
      <>
        {visible.map((item) => {
          const shortcut = shortcutFor(item)
          return (
            <DropdownMenuItem
              key={item.id}
              onSelect={() => item.run()}
              className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
            >
              <span className="flex text-muted-foreground">{item.icon}</span>
              <span className="flex-1">{item.label}</span>
              {shortcut ? <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut> : null}
            </DropdownMenuItem>
          )
        })}
        {below}
      </>
    )
  }

  const saveLayout = (next: NewTabMenuLayout): void => {
    setPendingLayout(next)
    void updateSettings({ newTabMenuLayout: next }).finally(() =>
      setPendingLayout((current) => (current === next ? null : current))
    )
  }
  const activeItem = visible[active]
  const customizeLabel = t('tabBar.createRow.customize', 'Customize')

  return (
    <>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger
          hideChevron
          variant="icon-row"
          className="group/create-row"
          aria-label={t(
            'tabBar.createRow.label',
            '{{item}}. Left and Right choose; the last stop customizes this row.',
            { item: activeItem?.label ?? customizeLabel }
          )}
          onPointerEnter={() => {
            pointerInside.current = true
            setKeyboardNav(false)
          }}
          onPointerLeave={() => {
            pointerInside.current = false
          }}
          onFocus={(event) => {
            if (event.target === event.currentTarget) {
              setRowFocused(true)
              setKeyboardNav(!pointerInside.current)
            }
          }}
          onBlur={() => setRowFocused(false)}
          onKeyDown={(event) => {
            setKeyboardNav(true)
            setHoveredIndex(null)
            if (event.key === 'ArrowLeft') {
              event.preventDefault()
              setActiveIndex(Math.max(0, active - 1))
              scroller.revealIcon(Math.max(0, active - 1))
            } else if (event.key === 'ArrowRight' && active < customizeIndex) {
              event.preventDefault()
              setActiveIndex(active + 1)
              scroller.revealIcon(active + 1)
            } else if ((event.key === 'Enter' || event.key === ' ') && activeItem) {
              event.preventDefault()
              run(activeItem)
            }
            // On the gear, Right/Enter/Space fall through to Radix, which opens the submenu.
          }}
        >
          <div
            // Why: only the gear opens the customizer; the strip (icons, gaps, scroll rail) never does.
            className={cn(
              'group/tab-strip relative flex min-w-0 flex-1',
              // A lane under the icons so the scroll rail never sits on them.
              scroller.overflow.hasOverflow && 'pb-1.5'
            )}
            onPointerMove={(event) => event.preventDefault()}
            onClick={(event) => event.preventDefault()}
          >
            <div
              ref={scroller.attachScroller}
              className={cn(
                'flex min-w-0 flex-1 gap-0.5 overflow-x-auto overflow-y-hidden scrollbar-none',
                getTabStripScrollMaskClassName(scroller.overflow)
              )}
            >
              {visible.map((item, index) => {
                const shortcut = shortcutFor(item)
                const highlighted = (keyboardActive && index === active) || hoveredIndex === index
                return (
                  <Tooltip key={item.id} open={highlighted}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        tabIndex={-1}
                        aria-label={item.label}
                        className={cn(
                          'flex h-7 w-9 shrink-0 items-center justify-center rounded-[7px] text-muted-foreground outline-hidden',
                          highlighted && 'bg-black/8 text-foreground dark:bg-white/14'
                        )}
                        // Why move, not enter: scrolling slides icons under a resting cursor without a real hover.
                        onPointerMove={() => {
                          setKeyboardNav(false)
                          setHoveredIndex(index)
                        }}
                        onPointerLeave={() =>
                          setHoveredIndex((current) => (current === index ? null : current))
                        }
                        onClick={() => run(item)}
                      >
                        {item.icon}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={6}>
                      {item.label}
                      {shortcut ? <span className="ml-2 opacity-60">{shortcut}</span> : null}
                    </TooltipContent>
                  </Tooltip>
                )
              })}
            </div>
            <TabStripScrollIndicator
              hasOverflow={scroller.overflow.hasOverflow}
              scrollContainerRef={scroller.scrollerRef}
            />
          </div>
          <Tooltip open={keyboardActive && active === customizeIndex}>
            <TooltipTrigger asChild>
              <span
                className="flex h-7 shrink-0 items-center gap-1 self-start pl-1"
                aria-hidden="true"
              >
                <span className="h-4 w-px bg-border" />
                <span
                  className={cn(
                    'flex size-7 items-center justify-center rounded-[7px] text-muted-foreground/70 hover:bg-black/8 hover:text-foreground dark:hover:bg-white/14',
                    'group-data-[state=open]/create-row:bg-black/8 group-data-[state=open]/create-row:text-foreground dark:group-data-[state=open]/create-row:bg-white/14',
                    keyboardActive &&
                      active === customizeIndex &&
                      'bg-black/8 text-foreground dark:bg-white/14'
                  )}
                >
                  <Settings className="size-3.5" />
                </span>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {customizeLabel}
            </TooltipContent>
          </Tooltip>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent
          collisionPadding={8}
          className="w-[19rem]"
          onEscapeKeyDown={(event) => {
            // The recorder cancels itself on Escape; keep the menu open around it.
            if (recordingActionId !== null) {
              event.preventDefault()
            }
          }}
          onFocusOutside={(event) => {
            if (recordingActionId !== null) {
              event.preventDefault()
            }
          }}
        >
          <TabBarCreateRowCustomizer
            visible={visible}
            hidden={hidden}
            recordingActionId={recordingActionId}
            onRecordingChange={setRecordingActionId}
            onArrange={(visibleIds, hiddenIds) => {
              saveLayout(buildNewTabMenuLayout(visibleIds, hiddenIds, layout))
              for (const item of hidden) {
                if (item.enable && visibleIds.includes(item.id)) {
                  void item.enable()
                }
              }
            }}
            onReset={() => saveLayout(EMPTY_LAYOUT)}
            onOpenShortcutSettings={() => {
              closeMenu()
              const store = useAppStore.getState()
              store.openSettingsTarget({ pane: 'shortcuts', repoId: null })
              store.openSettingsPage()
            }}
          />
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      {below}
    </>
  )
}
