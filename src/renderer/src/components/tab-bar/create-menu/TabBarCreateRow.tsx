import React, { useRef, useState } from 'react'
import { Settings } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { cn } from '@/lib/class-names'
import { formatOptionalPrimaryShortcutLabel } from '@/lib/keyboard/useShortcutLabel'
import {
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  useDropdownMenuClose
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useShortcutRecorderFocus } from '../../settings/shortcuts/use-shortcut-recorder-focus'
import {
  arrangeNewTabMenuItems,
  buildNewTabMenuLayout,
  type NewTabMenuLayout,
  type NewTabMenuSettings
} from '../../../../../shared/new-tab-menu/new-tab-menu-layout'
import type { KeybindingActionId } from '../../../../../shared/keybindings/types'
import type { TabBarCreateRowItem } from './tab-bar-create-row-item'
import { TabBarCreateRowCustomizer } from './TabBarCreateRowCustomizer'
import { CREATE_ROW_HIGHLIGHT_CLASS, TabBarCreateRowIcons } from './TabBarCreateRowIcons'
import { useCreateRowScroller } from './use-create-row-scroller'
import { isPressedPointer, useCreateRowHoverTooltip } from './use-create-row-hover-tooltip'
import type { IntroArrowAnchor } from '../../emulator-pane/tab-intro/use-intro-arrow'

const EMPTY_LAYOUT: NewTabMenuLayout = { order: [], hidden: [] }

/**
 * The + menu's create actions as one row of icons that scrolls sideways when it overflows,
 * ending in a gear that opens a submenu to reorder, hide, and assign shortcuts to them.
 * ←/→ walk the icons and the gear.
 */
export function TabBarCreateRow({
  items,
  customizable,
  layoutSetting,
  renderBelow
}: {
  items: readonly TabBarCreateRowItem[]
  customizable: boolean
  layoutSetting: keyof NewTabMenuSettings
  /** Content tied to shown items, e.g. an intro for an icon the user has not hidden. */
  renderBelow?: (shownIds: ReadonlySet<string>, anchor: IntroArrowAnchor) => React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const closeMenu = useDropdownMenuClose()
  const keybindings = useAppStore((state) => state.keybindings)
  const savedLayout = useAppStore((state) => state.settings?.[layoutSetting])
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
  const hoverTooltip = useCreateRowHoverTooltip()
  const { scrollerRef, scroller, attachScroller, overflow, revealIcon } = useCreateRowScroller()
  const [recordingActionId, setRecordingActionId] = useState<KeybindingActionId | null>(null)
  const customizeIndex = visible.length
  const active = Math.min(activeIndex, customizeIndex)
  const keyboardActive = rowFocused && keyboardNav
  const visibleIds = visible.map((item) => item.id)
  const below = renderBelow?.(new Set(visibleIds), { scroller, order: visibleIds.join(' ') })

  useShortcutRecorderFocus(recordingActionId !== null)

  const run = (item: TabBarCreateRowItem): void => {
    item.run()
    closeMenu()
  }

  if (!customizable) {
    return (
      <>
        {visible.map((item) => {
          const shortcut = item.actionId
            ? formatOptionalPrimaryShortcutLabel(item.actionId, keybindings)
            : null
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
    void updateSettings({ [layoutSetting]: next }).finally(() =>
      setPendingLayout((current) => (current === next ? null : current))
    )
  }
  const activeItem = visible[active]
  // The pointer may enter the row first or already be inside it; either way the keyboard label
  // it replaces counts as just shown, so the next icon opens without a cold wait. A press or drag
  // is not hover intent and gets no head start.
  const handOffToPointer = (pressed: boolean): void => {
    if (keyboardActive && !pressed) {
      hoverTooltip.startSkipWindow()
    }
    setKeyboardNav(false)
  }
  const recorderHasFocus = (): boolean =>
    document.activeElement?.matches('[data-shortcut-recorder-active]') ?? false
  const customizeLabel = t('tabBar.createRow.customize', 'Customize')

  return (
    <>
      <DropdownMenuSub
        onOpenChange={(open) => {
          // Closing the customizer mid-recording must not leave global shortcuts suspended.
          if (!open) {
            setRecordingActionId(null)
          }
        }}
      >
        <DropdownMenuSubTrigger
          hideChevron
          variant="icon-row"
          className="group/create-row"
          aria-label={t(
            'tabBar.createRow.label',
            'New tab actions. Left and Right choose; the last one customizes this row.'
          )}
          onPointerEnter={(event) => {
            pointerInside.current = true
            handOffToPointer(isPressedPointer(event))
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
            hoverTooltip.hover(null)
            if (event.key === 'ArrowLeft') {
              event.preventDefault()
              setActiveIndex(Math.max(0, active - 1))
              revealIcon(Math.max(0, active - 1))
            } else if (event.key === 'ArrowRight' && active < customizeIndex) {
              event.preventDefault()
              setActiveIndex(active + 1)
              revealIcon(active + 1)
            } else if ((event.key === 'Enter' || event.key === ' ') && activeItem) {
              event.preventDefault()
              run(activeItem)
            }
            // On the gear, Right/Enter/Space fall through to Radix, which opens the submenu.
          }}
        >
          <TabBarCreateRowIcons
            items={visible}
            highlightedIndex={keyboardActive ? active : hoveredIndex}
            tooltipIndex={keyboardActive ? active : hoverTooltip.tooltipIndex}
            overflow={overflow}
            scrollerRef={scrollerRef}
            attachScroller={attachScroller}
            onEscape={closeMenu}
            onHover={(index, pressed) => {
              if (index !== null) {
                handOffToPointer(pressed ?? false)
              }
              setHoveredIndex(index)
              hoverTooltip.hover(index, pressed)
            }}
            onPress={hoverTooltip.press}
            onRun={run}
          />
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
                    keyboardActive && active === customizeIndex && CREATE_ROW_HIGHLIGHT_CLASS
                  )}
                >
                  <Settings className="size-3.5" />
                </span>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6} onEscapeKeyDown={closeMenu}>
              {customizeLabel}
            </TooltipContent>
          </Tooltip>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent
          scrollable
          collisionPadding={8}
          className="w-[19rem]"
          // A focused recorder takes Escape and keeps the menu open; once focus leaves it, recording ends.
          onEscapeKeyDown={(event) => {
            if (recorderHasFocus()) {
              event.preventDefault()
            } else {
              setRecordingActionId(null)
            }
          }}
          onFocusOutside={(event) => {
            if (recorderHasFocus()) {
              event.preventDefault()
            } else {
              setRecordingActionId(null)
            }
          }}
        >
          <TabBarCreateRowCustomizer
            visible={visible}
            hidden={hidden}
            recordingActionId={recordingActionId}
            onRecordingChange={setRecordingActionId}
            onArrange={(visibleIds, hiddenIds) => {
              const next = buildNewTabMenuLayout(visibleIds, hiddenIds, layout)
              // A turned-off item sits under Hidden only while off; don't save that as a user choice.
              const offIds = new Set(hidden.filter((item) => item.enable).map((item) => item.id))
              const keptHidden = new Set(layout?.hidden)
              saveLayout({
                ...next,
                hidden: next.hidden.filter((id) => !offIds.has(id) || keptHidden.has(id))
              })
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
      {/* The row is one menu item; announce which icon ←/→ landed on. */}
      <span className="sr-only" aria-live="polite">
        {keyboardActive ? (activeItem?.label ?? customizeLabel) : ''}
      </span>
      {below}
    </>
  )
}
