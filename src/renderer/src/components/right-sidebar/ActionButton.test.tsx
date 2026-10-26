import { describe, expect, it, vi } from 'vitest'
import { Plus } from 'lucide-react'
import { ActionButton } from './source-control/listing/action-button'
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

// Only these event fields are read; narrow the mock instead of double-casting it.
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
    // Assert the rendered Radix tooltip rather than the removed native title.
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
    // DOM disabled blocks tooltip pointer events in Chromium; aria-disabled needs an explicit activation guard.
    const element = ActionButton({ ...baseProps, onClick: vi.fn(), disabled: true })
    const button = findInnerButton(element)
    expect(button.props.disabled).toBeUndefined()
  })

  it('marks the inner button aria-disabled when the disabled prop is true', () => {
    const element = ActionButton({ ...baseProps, onClick: vi.fn(), disabled: true })
    const button = findInnerButton(element)
    expect(button.props['aria-disabled']).toBe(true)
  })

  it('swallows clicks and calls preventDefault when disabled', () => {
    const onClick = vi.fn()
    const element = ActionButton({ ...baseProps, onClick, disabled: true })
    const button = findInnerButton(element)
    const { event, preventDefault } = makeClickEvent()
    ;(button.props.onClick as (e: MinimalMouseEvent) => void)(event)
    // Enter/Space also dispatch onClick; disabled must guard keyboard and pointer activation.
    expect(onClick).not.toHaveBeenCalled()
    expect(preventDefault).toHaveBeenCalledTimes(1)
  })
})
