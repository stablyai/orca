import { useEffectEvent, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Ellipsis } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { useNativeChatPickerFocusReturn } from './native-chat-picker-focus-return'

export type NativeChatComposerControl = {
  id: string
  content: ReactNode
  /** Lower priorities give way first; absent pins a control beside Send. */
  priority?: number
  overflow?: (close: () => void) => ReactNode
}

type Layout = { compact: boolean; hidden: string[]; terminal: boolean }

export function NativeChatComposerToolbar({
  left,
  right,
  primary,
  focusComposer
}: {
  left: NativeChatComposerControl[]
  right: NativeChatComposerControl[]
  primary: ReactNode
  focusComposer?: () => void
}): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const primaryRef = useRef<HTMLDivElement>(null)
  const moreRef = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState<Layout>({ compact: false, hidden: [], terminal: false })
  const [open, setOpen] = useState(false)
  const menuControls = useRef<string[]>([])
  const focusReturn = useNativeChatPickerFocusReturn(focusComposer, true)
  const controls = [...left, ...right]
  const measure = useEffectEvent(() => {
    const bar = root.current
    if (!bar || bar.clientWidth === 0) {
      return
    }
    const nodes = Array.from(bar.querySelectorAll<HTMLElement>('[data-composer-control]'))
    bar.dataset.terminal = 'false'
    const widths = new Map<string, number>()
    const gap = (element: Element | null): number =>
      element ? Number.parseFloat(getComputedStyle(element).columnGap) || 0 : 0
    const leftGap = gap(bar.firstElementChild)
    const rightGap = gap(bar.lastElementChild)
    const groupGap = gap(bar)
    const primaryWidth = primaryRef.current?.getBoundingClientRect().width ?? 0
    const moreWidth = moreRef.current?.getBoundingClientRect().width ?? 0
    const required = (hidden: string[]): number => {
      const shown = (items: NativeChatComposerControl[]) =>
        items.filter((item) => !hidden.includes(item.id))
      const leading = shown(left)
      const trailing = shown(right)
      const more = hidden.length > 0 || open
      return (
        [...leading, ...trailing].reduce((sum, item) => sum + (widths.get(item.id) ?? 0), 0) +
        primaryWidth +
        (more ? moreWidth : 0) +
        Math.max(0, leading.length + Number(more) - 1) * leftGap +
        trailing.length * rightGap +
        (leading.length > 0 || more ? groupGap : 0)
      )
    }
    let next: Layout = { compact: false, hidden: [], terminal: false }
    // Probe the same mounted controls before paint; hidden controls retain their natural measure.
    for (const compact of open ? [true] : [false, true]) {
      bar.dataset.compact = String(compact)
      for (const node of nodes) {
        widths.set(node.dataset.composerControl!, node.getBoundingClientRect().width)
      }
      next = { compact, hidden: open ? [...menuControls.current] : [], terminal: false }
      if (required(next.hidden) <= bar.clientWidth) {
        break
      }
      if (compact) {
        const active = nodes.find((node) => node.querySelector('[aria-expanded="true"]'))?.dataset
          .composerControl
        const candidates = controls
          .filter(
            (item) =>
              item.priority !== undefined && item.id !== active && !next.hidden.includes(item.id)
          )
          .sort((a, b) => a.priority! - b.priority!)
        for (const item of candidates) {
          if (required(next.hidden) <= bar.clientWidth) {
            break
          }
          next.hidden.push(item.id)
        }
        next.terminal = required(next.hidden) > bar.clientWidth
        bar.dataset.terminal = String(next.terminal)
        const atomicWidth = Math.max(
          primaryRef.current?.getBoundingClientRect().width ?? 0,
          moreWidth,
          ...controls
            .filter((item) => !next.hidden.includes(item.id))
            .map((item) => widths.get(item.id) ?? 0)
        )
        const host = bar.closest<HTMLElement>('[data-composer-field]')
        const atomic = `${atomicWidth}px`
        if (host && host.style.getPropertyValue('--composer-atomic-width') !== atomic) {
          host.style.setProperty('--composer-atomic-width', atomic)
        }
      }
    }
    // An open menu keeps its actions mounted through resize until the user dismisses it.
    if (open) {
      menuControls.current = next.hidden
    }
    bar.dataset.compact = String(next.compact)
    setLayout((previous) =>
      previous.compact === next.compact &&
      previous.hidden.join() === next.hidden.join() &&
      previous.terminal === next.terminal
        ? previous
        : next
    )
  })
  useLayoutEffect(() => measure(), [open])
  useLayoutEffect(() => {
    const bar = root.current
    if (!bar) {
      return
    }
    const resize = new ResizeObserver(() => measure())
    const observe = (): void => {
      resize.disconnect()
      resize.observe(bar)
      const host = bar.closest('[data-composer-field]')
      if (host) {
        resize.observe(host)
      }
      for (const node of bar.querySelectorAll<HTMLElement>('[data-composer-control]')) {
        resize.observe(node)
      }
      if (primaryRef.current) {
        resize.observe(primaryRef.current)
      }
      if (moreRef.current) {
        resize.observe(moreRef.current)
      }
      measure()
    }
    const mutations = new MutationObserver(observe)
    mutations.observe(bar, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['aria-expanded']
    })
    document.fonts?.addEventListener('loadingdone', observe)
    observe()
    return () => {
      resize.disconnect()
      mutations.disconnect()
      document.fonts?.removeEventListener('loadingdone', observe)
    }
  }, [])

  const renderControl = (item: NativeChatComposerControl): ReactNode => {
    const hidden = layout.hidden.includes(item.id)
    return (
      <div
        key={item.id}
        data-composer-control={item.id}
        aria-hidden={hidden || undefined}
        inert={hidden || undefined}
        className={`inline-flex w-max shrink-0 ${hidden ? 'pointer-events-none invisible absolute' : ''}`}
      >
        {item.content}
      </div>
    )
  }
  const more = layout.hidden.length > 0 || open
  return (
    <div
      ref={root}
      data-compact={layout.compact}
      data-terminal={layout.terminal}
      className="group/toolbar flex w-full items-center justify-between gap-2 text-chat-foreground-faint data-[terminal=true]:flex-wrap data-[terminal=true]:justify-end data-[terminal=true]:[&_[data-composer-primary-label]]:hidden data-[terminal=true]:[&_[data-composer-primary-icon]]:block data-[terminal=false]:[&_[data-composer-primary-icon]]:hidden data-[compact=true]:[&_[data-composer-label]]:invisible data-[compact=true]:[&_[data-composer-label]]:absolute data-[compact=true]:[&_[data-composer-label]]:w-max data-[compact=true]:[&_[data-composer-compact-icon]]:block data-[compact=false]:[&_[data-composer-compact-icon]]:hidden"
    >
      <div className="flex shrink-0 items-center gap-0.5 group-data-[terminal=true]/toolbar:contents">
        {left.map(renderControl)}
        <Popover
          open={open}
          onOpenChange={(value) => {
            menuControls.current = value ? layout.hidden : []
            setOpen(value)
          }}
        >
          <div
            ref={moreRef}
            inert={!more || undefined}
            aria-hidden={!more || undefined}
            className={more ? 'inline-flex shrink-0' : 'pointer-events-none invisible absolute'}
          >
            <PopoverTrigger asChild>
              <Button
                ref={focusReturn.triggerRef}
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={translate(
                  'components.native-chat.composer.moreControls',
                  'More chat controls'
                )}
              >
                <Ellipsis className="size-4" />
              </Button>
            </PopoverTrigger>
          </div>
          <PopoverContent
            side="top"
            align="start"
            className="w-72"
            onInteractOutside={focusReturn.onInteractOutside}
            onCloseAutoFocus={focusReturn.onCloseAutoFocus}
          >
            <div className="flex flex-col gap-2">
              {controls
                .filter((item) => layout.hidden.includes(item.id))
                .map((item) => (
                  <div key={item.id} className="flex items-center">
                    {item.overflow?.(() => {
                      focusReturn.notePick()
                      menuControls.current = []
                      setOpen(false)
                    }) ?? item.content}
                  </div>
                ))}
            </div>
          </PopoverContent>
        </Popover>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1.5 group-data-[terminal=true]/toolbar:contents">
        {right.map(renderControl)}
        <div ref={primaryRef} className="inline-flex shrink-0">
          {primary}
        </div>
      </div>
    </div>
  )
}
