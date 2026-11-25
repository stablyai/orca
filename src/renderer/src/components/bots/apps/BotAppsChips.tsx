// Add apps' filter chips: All, each category with an app, then Composio and Custom. Categories that
// don't fit fold, from the end, into More; Composio and Custom always show. Add an MCP server uses
// them too, with its own categories and no Composio.
import React, { useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import type { BotAppCategory } from './bot-app-catalog'

/** What the list shows: everything, the bot's own, one category, Composio's apps, or the custom ones. */
export type BotAppsView = AppsView<BotAppCategory>
export type AppsView<C extends string> = 'all' | 'mine' | C | 'composio' | 'catalog' | 'custom'

type Chip<C extends string> = { value: AppsView<C>; label: string }

const CHIP =
  'inline-flex h-7.5 shrink-0 cursor-pointer items-center gap-1 rounded-full bg-secondary px-3 text-sm font-medium whitespace-nowrap text-secondary-foreground transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-[on=true]:bg-foreground data-[on=true]:text-background'
const GAP = 6
// The More menu's own chip id, apart from any category's (Add an MCP server has a "more" category).
const FOLD = 'fold:more'

function MoreFace({ label }: { label: string }): React.JSX.Element {
  return (
    <>
      <span className="max-w-40 truncate">{label}</span>
      <ChevronDown className="size-3.5 shrink-0" />
    </>
  )
}

function fitCategoryChips(row: HTMLElement, mirror: HTMLElement): number {
  // Use layout widths so the dialog's entrance animation cannot shrink the measurement.
  const measured = (kind: string): number[] =>
    [...mirror.querySelectorAll<HTMLElement>(`[data-measure="${kind}"]`)].map((node) =>
      Number.parseFloat(getComputedStyle(node).width)
    )
  const categories = measured('category')
  const available = row.clientWidth
  let used = [...measured('fixed'), ...categories].reduce((sum, width) => sum + width + GAP, -GAP)
  if (available === 0 || used <= available) {
    return categories.length
  }
  const options = measured('more-option')
  let moreWidth = measured('more')[0] ?? 0
  // Reserve room for the widest label among the folded categories so choosing one cannot reflow.
  for (let shown = categories.length - 1; shown >= 0; shown--) {
    used -= categories[shown]! + GAP
    moreWidth = Math.max(moreWidth, options[shown] ?? 0)
    if (used + GAP + moreWidth <= available) {
      return shown
    }
  }
  return 0
}

function updateScrollFade(row: HTMLElement): void {
  row.toggleAttribute('data-fade-start', row.scrollLeft > 1)
  row.toggleAttribute('data-fade-end', row.scrollLeft + row.clientWidth + 1 < row.scrollWidth)
}

export function BotAppsChips<C extends string = BotAppCategory>({
  view,
  onView,
  categories,
  categoryName,
  composio = true
}: {
  view: AppsView<C>
  onView: (view: AppsView<C>) => void
  /** Categories with an app, in order. */
  categories: readonly C[]
  categoryName: (category: C) => string
  composio?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const rowRef = useRef<HTMLDivElement>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)
  const moreMenuRef = useRef<HTMLDivElement>(null)
  const restoreMenuFocus = useRef(false)
  // The category whose menu option had focus when a resize brought its chip back into the row.
  const menuHandoff = useRef<string | null>(null)
  // Set once focus is handed to a chip, so the closing menu doesn't send it back to More.
  const handedOff = useRef(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const all: Chip<C> = { value: 'all', label: t('bots.apps.chip.all', 'All') }
  const categoryChips: Chip<C>[] = categories.map((category) => ({
    value: category,
    label: categoryName(category)
  }))
  const pinned: Chip<C>[] = [
    ...(composio
      ? [{ value: 'composio' as const, label: t('bots.apps.chip.composio', 'Composio') }]
      : []),
    { value: 'custom', label: t('bots.apps.custom.name', 'Custom') }
  ]
  const moreLabel = t('bots.apps.chip.more', 'More')
  const selected: AppsView<C> = view === 'catalog' ? 'composio' : view
  const [shown, setShown] = useState(categoryChips.length)
  const [focusedChip, setFocusedChip] = useState<string | null>(null)

  const labels = [all, ...categoryChips, ...pinned].map((chip) => chip.label).join('\n')
  const categoryCount = categoryChips.length
  useLayoutEffect(() => {
    const row = rowRef.current
    const mirror = mirrorRef.current
    if (!row || !mirror) {
      return
    }
    const measure = (): void => {
      const next = fitCategoryChips(row, mirror)
      const active = row.ownerDocument.activeElement
      if (moreMenuRef.current?.contains(active)) {
        const option =
          active instanceof HTMLElement
            ? active.closest<HTMLElement>('[data-more-option]')?.dataset.moreOption
            : undefined
        const order = [...mirror.querySelectorAll<HTMLElement>('[data-measure="category"]')].map(
          (node) => node.dataset.value
        )
        const index = option === undefined ? -1 : order.indexOf(option)
        const unfolds = index !== -1 && index < next
        // The focused option leaves More, or More itself goes: close it and hand focus to the row.
        if (unfolds || next === categoryCount) {
          restoreMenuFocus.current = true
          menuHandoff.current = unfolds ? (option ?? null) : null
          setMenuOpen(false)
        }
      }
      if (next === categoryCount) {
        // More remounts closed when a later resize folds categories again.
        setMenuOpen(false)
      }
      setShown(next)
      updateScrollFade(row)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    observer.observe(mirror)
    return () => observer.disconnect()
  }, [labels, moreLabel, categoryCount])
  useLayoutEffect(() => {
    if (rowRef.current) {
      updateScrollFade(rowRef.current)
    }
  }, [labels, moreLabel, selected, shown])

  const visible = categoryChips.slice(0, shown)
  const folded = categoryChips.slice(shown)
  const foldedPick = folded.find((chip) => chip.value === selected)
  const front = [all, ...visible, ...pinned]
  const selectedChip = front.some((chip) => chip.value === selected)
    ? selected
    : foldedPick
      ? FOLD
      : 'all'
  const focusedChipFolds = folded.some((chip) => chip.value === focusedChip)
  const tabStop = focusedChipFolds
    ? FOLD
    : front.some((chip) => chip.value === focusedChip) ||
        (focusedChip === FOLD && folded.length > 0)
      ? focusedChip
      : selectedChip

  useLayoutEffect(() => {
    const row = rowRef.current
    const restore = restoreMenuFocus.current
    const target = menuHandoff.current
    restoreMenuFocus.current = false
    menuHandoff.current = null
    if (!row) {
      return
    }
    const doc = row.ownerDocument
    // Losing the focused chip or menu option to resize leaves focus on the document body.
    const lost = doc.activeElement === doc.body
    const unfolded = target ? row.querySelector<HTMLButtonElement>(`[data-chip="${target}"]`) : null
    if (restore && unfolded && (lost || moreMenuRef.current?.contains(doc.activeElement))) {
      handedOff.current = true
      unfolded.focus()
      return
    }
    const moreWasRemoved = folded.length === 0 && (focusedChip === FOLD || restore)
    if ((focusedChipFolds || moreWasRemoved) && lost) {
      row.querySelector<HTMLButtonElement>('[data-chip][tabindex="0"]')?.focus()
    }
  }, [focusedChip, focusedChipFolds, folded.length])

  const chip = (item: Chip<C>): React.JSX.Element => (
    <button
      key={item.value}
      type="button"
      role="radio"
      aria-checked={item.value === selected}
      data-on={item.value === selected}
      data-chip={item.value}
      tabIndex={tabStop === item.value ? 0 : -1}
      className={CHIP}
      onClick={() => onView(item.value)}
    >
      {item.label}
    </button>
  )

  // The menu trigger owns ArrowDown, so users can open it with the same key as other menus.
  const moveFocus = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!(event.target instanceof HTMLButtonElement)) {
      return
    }
    const chips = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-chip]')]
    const index = chips.indexOf(event.target)
    const isMenu = chips[index]?.hasAttribute('aria-haspopup')
    const next =
      event.key === 'ArrowRight' || (event.key === 'ArrowDown' && !isMenu)
        ? index + 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? index - 1 + chips.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? chips.length - 1
              : null
    if (next === null || index === -1) {
      return
    }
    event.preventDefault()
    chips[next % chips.length]?.focus()
  }

  return (
    <div
      role="toolbar"
      aria-label={t('bots.apps.filters', 'App filters')}
      className="relative min-w-0 overflow-clip"
    >
      <div
        ref={rowRef}
        role="radiogroup"
        aria-label={t('bots.apps.categories', 'Categories')}
        onKeyDown={moveFocus}
        onFocus={(event) => {
          if (event.target instanceof HTMLButtonElement && event.target.dataset.chip) {
            setFocusedChip(event.target.dataset.chip)
          }
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setFocusedChip(null)
          }
        }}
        onScroll={(event) => updateScrollFade(event.currentTarget)}
        className="flex min-w-0 gap-1.5 overflow-x-auto scrollbar-none mask-[linear-gradient(to_right,transparent,black_var(--fade-start,0px),black_calc(100%_-_var(--fade-end,0px)),transparent)] data-fade-start:[--fade-start:12px] data-fade-end:[--fade-end:12px]"
      >
        {chip(all)}
        {visible.map(chip)}
        {folded.length > 0 ? (
          <DropdownMenu
            modal={false}
            open={menuOpen}
            onOpenChange={(open) => {
              if (open) {
                handedOff.current = false
              }
              setMenuOpen(open)
            }}
          >
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                role="radio"
                aria-checked={foldedPick !== undefined}
                aria-haspopup="menu"
                aria-expanded={undefined}
                data-on={foldedPick !== undefined}
                data-chip={FOLD}
                tabIndex={tabStop === FOLD ? 0 : -1}
                title={foldedPick?.label}
                className={CHIP}
              >
                <MoreFace label={foldedPick?.label ?? moreLabel} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              ref={moreMenuRef}
              align="start"
              onCloseAutoFocus={(event) => {
                if (handedOff.current) {
                  handedOff.current = false
                  event.preventDefault()
                }
              }}
            >
              <DropdownMenuRadioGroup
                value={selected}
                onValueChange={(value) => {
                  const picked = folded.find((option) => option.value === value)
                  if (picked) {
                    onView(picked.value)
                  }
                }}
              >
                {folded.map((option) => (
                  <DropdownMenuRadioItem
                    key={option.value}
                    value={option.value}
                    data-more-option={option.value}
                  >
                    {option.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {pinned.map(chip)}
      </div>
      {/* Every chip at its natural width, for the fit; never seen or reached. */}
      <div
        ref={mirrorRef}
        aria-hidden
        inert
        className="pointer-events-none invisible absolute top-0 left-0 flex w-max gap-1.5"
      >
        {[all, ...pinned].map((item) => (
          <span key={item.value} data-measure="fixed" className={CHIP}>
            {item.label}
          </span>
        ))}
        {categoryChips.map((item) => (
          <span key={item.value} data-measure="category" data-value={item.value} className={CHIP}>
            {item.label}
          </span>
        ))}
        <span data-measure="more" className={CHIP}>
          <MoreFace label={moreLabel} />
        </span>
        {categoryChips.map((item) => (
          <span key={item.value} data-measure="more-option" className={CHIP}>
            <MoreFace label={item.label} />
          </span>
        ))}
      </div>
    </div>
  )
}
