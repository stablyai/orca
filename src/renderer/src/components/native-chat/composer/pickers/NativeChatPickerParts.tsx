import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { SkillSourceKind } from '../../../../../../shared/skills/discovery/skills'
import type { NativeChatPickerItem } from '../../../../../../shared/native-chat/input/composer/native-chat-picker-items'
// The `@`, `/` and `$` menus' shared pieces: the portaled listbox, an option row and a status line.
import { createPortal } from 'react-dom'
import { autoUpdate, computePosition, offset, size } from '@floating-ui/dom'
import { useLayoutEffect, useRef, useState } from 'react'
import { cn } from '@/lib/class-names'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'

export function PickerStatus({
  busy = false,
  className,
  children
}: {
  busy?: boolean
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn('flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground', className)}
    >
      {busy ? <LoadingSpinner className="size-3.5" /> : null}
      {children}
    </div>
  )
}

export function PickerListbox({
  id,
  maxHeight = 'calc(var(--spacing) * 72)',
  children
}: {
  id: string
  maxHeight?: string
  children: React.ReactNode
}): React.JSX.Element {
  const marker = useRef<HTMLSpanElement>(null)
  const listbox = useRef<HTMLDivElement>(null)
  const [container, setContainer] = useState<HTMLElement | null>(null)
  // Inside the launch setup (a popover or the new-tab menu's submenu), take the menu layer those overlays use.
  const [inOverlay, setInOverlay] = useState(false)
  useLayoutEffect(() => {
    setContainer(marker.current?.closest<HTMLElement>('.native-chat-appearance') ?? document.body)
    setInOverlay(
      Boolean(
        marker.current?.closest(
          '[data-slot="popover-content"], [data-slot="dropdown-menu-sub-content"]'
        )
      )
    )
  }, [])
  useLayoutEffect(() => {
    const anchor = marker.current?.parentElement
    const floating = listbox.current
    if (!anchor || !floating) {
      return
    }
    // autoUpdate also follows moves with no resize or scroll, like dragging the floating panel.
    return autoUpdate(anchor, floating, () => {
      void computePosition(anchor, floating, {
        strategy: 'fixed',
        placement: 'top-start',
        middleware: [
          offset(4),
          size({
            padding: 8,
            apply: ({ rects, availableHeight }) => {
              floating.style.width = `${rects.reference.width}px`
              floating.style.maxHeight = `min(${maxHeight}, ${Math.max(0, availableHeight)}px)`
            }
          })
        ]
      }).then(({ x, y }) => {
        floating.style.left = `${x}px`
        floating.style.top = `${y}px`
      })
    })
  }, [container, maxHeight])
  return (
    <>
      <span ref={marker} />
      {container &&
        createPortal(
          <div
            ref={listbox}
            id={id}
            role="listbox"
            data-focus-behavior="composer-suggestions"
            className={`scrollbar-sleek fixed left-0 top-0 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-floating ${inOverlay ? 'z-[70]' : 'z-50'}`}
          >
            {children}
          </div>,
          container
        )}
    </>
  )
}

export function PickerOptionButton({
  id,
  selected,
  activeItemRef,
  onChoose,
  onHover,
  title,
  onPointerEnter,
  className,
  children
}: {
  id: string
  selected: boolean
  activeItemRef: React.MutableRefObject<HTMLButtonElement | null>
  onChoose: () => void
  /** One highlight: real pointer movement moves it, so rows sliding under a parked pointer during
   *  arrow keys don't take it (mousemove, not mouseenter). */
  onHover?: () => void
  title?: string
  onPointerEnter?: () => void
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      id={id}
      title={title}
      onPointerEnter={onPointerEnter}
      ref={selected ? activeItemRef : null}
      role="option"
      aria-selected={selected}
      type="button"
      onPointerDown={(event) => {
        // Accept before focus transfer because the textarea owns query and caret state.
        event.preventDefault()
        if (event.button === 0) {
          onChoose()
        }
      }}
      onMouseMove={(event) => {
        // Opening or scrolling under a resting pointer sends a zero-movement mousemove.
        const moved = event.movementX !== 0 || event.movementY !== 0
        if (onHover && !selected && moved) {
          onHover()
        }
      }}
      className={
        onHover
          ? cn(
              'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm',
              // A tint alone vanishes under forced colors, so High Contrast gets an outline.
              selected &&
                'bg-foreground/10 dark:bg-foreground/12 forced-colors:outline forced-colors:outline-2 forced-colors:-outline-offset-2 forced-colors:outline-[Highlight]',
              className
            )
          : cn(
              'flex w-full items-start gap-2 rounded-md border border-transparent px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground hover:[--muted-foreground:var(--accent-foreground)]',
              selected &&
                'border-border bg-accent text-accent-foreground [--muted-foreground:var(--accent-foreground)]',
              className
            )
      }
    >
      {children}
    </button>
  )
}

export function getPickerAnnotation(
  item: NativeChatPickerItem,
  t: Translate = translate
): string | null {
  if (item.kind === 'skill' && item.location) {
    return item.location
  }
  if (item.kind === 'command' && item.skillCollision) {
    return t(
      'components.native-chat.composer.skillCommandCollision',
      'Also a skill name - agent decides'
    )
  }
  if (item.kind === 'skill' && item.sources.length > 1) {
    // Use sourceCount because i18next treats count as pluralization input and these keys have no plural variants.
    return t(
      'components.native-chat.composer.skillMultipleSources',
      '{{sourceCount}} sources - agent resolves',
      { sourceCount: item.sources.length }
    )
  }
  return null
}

export function scopeLabel(
  sourceKind: SkillSourceKind | undefined,
  t: Translate = translate
): string {
  const labels: Record<string, string> = {
    repo: t('components.native-chat.composer.skillScopeProject', 'Project'),
    home: t('components.native-chat.composer.skillScopePersonal', 'Personal'),
    bundled: t('components.native-chat.composer.skillScopeBuiltIn', 'Built-in'),
    plugin: t('components.native-chat.composer.skillScopePlugin', 'Plugin')
  }
  return sourceKind ? (labels[sourceKind] ?? '') : ''
}
