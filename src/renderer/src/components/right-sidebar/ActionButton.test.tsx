import { describe, expect, it, vi } from 'vitest'
import { Plus } from 'lucide-react'
import { ActionButton } from './SourceControl'
import { Button } from '@/components/ui/button'

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

function visit(node: unknown, cb: (node: ReactElementLike) => void): void {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return
  }
  if (Array.isArray(node)) {
    node.forEach((entry) => visit(entry, cb))
    return
  }
  const element = node as ReactElementLike
  cb(element)
  if (element.props?.children) {
    visit(element.props.children, cb)
  }
}

function findInnerButton(node: unknown): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (entry.type === Button) {
      found = entry
    }
  })
  if (!found) {
    throw new Error('inner Button not found')
  }
  return found
}

function findTooltipContentText(node: unknown): string {
  const texts: string[] = []
  visit(node, (entry) => {
    const typeName =
      typeof entry.type === 'function' || typeof entry.type === 'object'
        ? ((entry.type as { displayName?: string; name?: string }).displayName ??
          (entry.type as { displayName?: string; name?: string }).name ??
          '')
        : ''
    if (typeName === 'TooltipContent') {
      const children = entry.props?.children
      if (typeof children === 'string') {
        texts.push(children)
      }
    }
  })
  return texts.join(' ')
}

// Why: ActionButton's onClick handler only touches these three fields, so a
// narrow event type is both correct and avoids a forbidden `as unknown as X`
// double-cast on the event value.
type MinimalMouseEvent = Pick<
  React.MouseEvent,
  'preventDefault' | 'stopPropagation' | 'defaultPrevented'
>

function makeClickEvent(): {
  event: MinimalMouseEvent
  preventDefault: ReturnType<typeof vi.fn>
} {
  const preventDefault = vi.fn()
  const event: MinimalMouseEvent = {
    preventDefault,
    stopPropagation: vi.fn(),
    defaultPrevented: false
  }
  return { event, preventDefault }
}

const baseProps = {
  icon: Plus,
  title: 'Stage all',
  onClick: vi.fn()
}

describe('ActionButton', () => {
  it('forwards the title as aria-label on the inner button', () => {
    const element = ActionButton({ ...baseProps, onClick: vi.fn() })
    const button = findInnerButton(element)
    expect(button.props['aria-label']).toBe('Stage all')
  })

  it('renders the title as tooltip content (non-native, Radix)', () => {
    const element = ActionButton({ ...baseProps, onClick: vi.fn() })
    // Why: the Radix TooltipContent is what renders the visual tooltip.
    // Native `title` was removed because its styling diverges from the
    // rest of the sidebar chrome.
    expect(findTooltipContentText(element)).toContain('Stage all')
  })

  it('calls the onClick handler when enabled', () => {
    const onClick = vi.fn()
    const element = ActionButton({ ...baseProps, onClick })
    const button = findInnerButton(element)
    const { event } = makeClickEvent()
    ;(button.props.onClick as (e: MinimalMouseEvent) => void)(event)
    expect(onClick).toHaveBeenCalledWith(event)
  })

  it('does NOT render the native disabled prop on the inner button', () => {
    // Why: Radix TooltipTrigger on a DOM-disabled <button> gets its pointer
    // events blocked in Chromium, suppressing the tooltip entirely — a
    // regression vs. the native `title` attribute it replaced. ActionButton
    // uses aria-disabled + a click guard instead.
    const element = ActionButton({ ...baseProps, onClick: vi.fn(), disabled: true })
    const button = findInnerButton(element)
    expect(button.props.disabled).toBeUndefined()
  })

  it('marks the inner button aria-disabled when the disabled prop is true', () => {
    const element = ActionButton({ ...baseProps, onClick: vi.fn(), disabled: true })
    const button = findInnerButton(element)
    expect(button.props['aria-disabled']).toBe(true)
  })

  it('applies the visual-disabled class when disabled', () => {
    const element = ActionButton({ ...baseProps, onClick: vi.fn(), disabled: true })
    const button = findInnerButton(element)
    expect(button.props.className).toContain('opacity-50')
    expect(button.props.className).toContain('cursor-not-allowed')
  })

  it('omits the visual-disabled class when enabled', () => {
    const element = ActionButton({ ...baseProps, onClick: vi.fn(), disabled: false })
    const button = findInnerButton(element)
    expect(button.props.className).not.toContain('opacity-50')
  })

  it('keeps the full icon button box as the hover and click target', () => {
    const element = ActionButton({ ...baseProps, onClick: vi.fn() })
    const button = findInnerButton(element)
    expect(button.props.className).not.toContain('h-auto')
    expect(button.props.className).not.toContain('w-auto')
    expect(button.props.className).toContain('hover:bg-background/70')
  })

  it('swallows clicks and calls preventDefault when disabled', () => {
    const onClick = vi.fn()
    const element = ActionButton({ ...baseProps, onClick, disabled: true })
    const button = findInnerButton(element)
    const { event, preventDefault } = makeClickEvent()
    ;(button.props.onClick as (e: MinimalMouseEvent) => void)(event)
    // Why: keyboard Enter/Space also fires onClick on a non-DOM-disabled
    // button. The guard must block both pointer and keyboard activation
    // while `disabled` is true, even though the inner handler is trusted
    // to early-return on `isExecutingBulk`.
    expect(onClick).not.toHaveBeenCalled()
    expect(preventDefault).toHaveBeenCalledTimes(1)
  })
})
