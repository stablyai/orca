// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionOptionDescriptor } from '../../../../../../../shared/native-chat/input/native-chat-session-options'
import { NativeChatSessionOptionRows } from './NativeChatSessionOptionRows'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

function effort(values = ['low', 'high']): SessionOptionDescriptor {
  return {
    id: 'effort',
    label: 'Effort',
    category: 'thought_level',
    kind: {
      type: 'select',
      currentValue: 'high',
      choices: values.map((value) => ({ value, label: value === 'low' ? 'Low' : 'High' }))
    },
    valueSource: 'reported',
    transport: 'agent-session',
    settable: true
  }
}

const slider = (): HTMLElement => screen.getByRole('slider', { name: 'Effort' })

function dragRoot(): HTMLElement {
  const root = slider().closest('[data-slot="slider"]')
  if (!(root instanceof HTMLElement)) {
    throw new Error('Missing effort slider root')
  }
  root.getBoundingClientRect = () => new DOMRect(0, 0, 100, 16)
  root.setPointerCapture = vi.fn()
  root.hasPointerCapture = () => true
  root.releasePointerCapture = vi.fn()
  return root
}

function setup() {
  const onSet = vi.fn()
  const rows = (descriptor = effort()) => (
    <NativeChatSessionOptionRows
      options={[descriptor]}
      pendingIds={new Set()}
      shownReason={null}
      onAction={() => {}}
      onSet={onSet}
    />
  )
  const view = render(rows())
  const root = dragRoot()
  fireEvent.pointerDown(root, { pointerId: 1, clientX: 0, clientY: 8 })
  expect(slider().getAttribute('aria-valuetext')).toBe('Low')
  expect(onSet).not.toHaveBeenCalled()
  return { onSet, root, rerender: (descriptor = effort()) => view.rerender(rows(descriptor)) }
}

afterEach(cleanup)

describe('effort drag lifetime', () => {
  it('captures an explicit press on the displayed provider default without requiring a change', () => {
    const onSet = vi.fn()
    render(
      <NativeChatSessionOptionRows
        options={[{ ...effort(), valueSource: 'default' }]}
        pendingIds={new Set()}
        shownReason={null}
        onAction={() => {}}
        onSet={onSet}
      />
    )
    const root = dragRoot()
    fireEvent.pointerDown(root, { pointerId: 1, clientX: 100, clientY: 8 })
    expect(onSet).not.toHaveBeenCalled()
    fireEvent.pointerUp(root, { pointerId: 1, clientX: 100, clientY: 8 })
    expect(onSet).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'effort' }), 'high')
  })

  it('preserves a draft across equivalent published snapshots and commits on release', () => {
    const { onSet, root, rerender } = setup()
    rerender()
    expect(slider().getAttribute('aria-valuetext')).toBe('Low')
    expect(dragRoot()).toBe(root)
    fireEvent.pointerUp(root, { pointerId: 1, clientX: 0, clientY: 8 })
    expect(onSet).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'effort' }), 'low')
  })

  it('cancels a gesture when the ordered provider choice set changes', () => {
    const { onSet, root, rerender } = setup()
    rerender(effort(['high', 'low']))
    expect(slider().getAttribute('aria-valuetext')).toBe('High')
    expect(dragRoot()).not.toBe(root)
    fireEvent.pointerUp(root, { pointerId: 1, clientX: 0, clientY: 8 })
    expect(onSet).not.toHaveBeenCalled()
  })

  it.each(['pointerCancel', 'lostPointerCapture'] as const)(
    'clears an uncommitted preview on %s',
    (event) => {
      const { onSet, root } = setup()
      fireEvent[event](root, { pointerId: 1 })
      expect(slider().getAttribute('aria-valuetext')).toBe('High')
      expect(onSet).not.toHaveBeenCalled()
    }
  )
})

describe('effort keyboard draft', () => {
  function mount() {
    const onSet = vi.fn()
    render(
      <NativeChatSessionOptionRows
        options={[effort(['low', 'medium', 'high'])]}
        pendingIds={new Set()}
        shownReason={null}
        onAction={() => {}}
        onSet={onSet}
      />
    )
    return onSet
  }

  it('previews multiple keyboard steps, then commits once on Enter', () => {
    const onSet = mount()
    fireEvent.keyDown(slider(), { key: 'Home' })
    fireEvent.keyDown(slider(), { key: 'ArrowRight' })
    expect(slider().getAttribute('aria-valuenow')).toBe('1')
    expect(onSet).not.toHaveBeenCalled()
    fireEvent.keyDown(slider(), { key: 'Enter' })
    fireEvent.blur(slider())
    expect(onSet).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 'effort' }),
      'medium'
    )
  })

  it('discards the keyboard draft on Escape without applying it on blur', () => {
    const onSet = mount()
    fireEvent.keyDown(slider(), { key: 'Home' })
    fireEvent.keyDown(slider(), { key: 'Escape' })
    fireEvent.blur(slider())
    expect(slider().getAttribute('aria-valuenow')).toBe('2')
    expect(onSet).not.toHaveBeenCalled()
  })

  it('applies the keyboard draft when leaving the control', () => {
    const onSet = mount()
    fireEvent.keyDown(slider(), { key: 'Home' })
    expect(onSet).not.toHaveBeenCalled()
    fireEvent.blur(slider())
    expect(onSet).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'effort' }), 'low')
  })
})
