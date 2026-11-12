// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { parsePluginDeclarativeTree } from '../../../../../shared/plugins/declarative/plugin-declarative-tree'
import type { PluginDeclarativeNode } from '../../../../../shared/plugins/declarative/plugin-declarative-catalog'
import { PluginDeclarativeView } from './PluginDeclarativeView'

afterEach(cleanup)

const cb = (id: string) => ({ $callback: id })
const node = (type: string, props: Record<string, unknown> = {}, children: unknown[] = []) => ({
  type,
  props,
  children
})

function tree(raw: unknown): PluginDeclarativeNode {
  const parsed = parsePluginDeclarativeTree(raw)
  if (!parsed.ok || !parsed.tree) {
    throw new Error(parsed.ok ? 'empty tree' : parsed.error)
  }
  return parsed.tree
}

function view(raw: unknown, onEvent = vi.fn(), onOpenLink = vi.fn()) {
  const result = render(
    <TooltipProvider>
      <PluginDeclarativeView tree={tree(raw)} onEvent={onEvent} onOpenLink={onOpenLink} />
    </TooltipProvider>
  )
  const rerender = (next: unknown) =>
    result.rerender(
      <TooltipProvider>
        <PluginDeclarativeView tree={tree(next)} onEvent={onEvent} onOpenLink={onOpenLink} />
      </TooltipProvider>
    )
  return { onEvent, onOpenLink, rerender }
}

describe('PluginDeclarativeView', () => {
  it('keeps typing the guest has not seen, and Enter submits what is on screen', () => {
    const raw = (value: string, edit: number) =>
      node('Input', { label: 'Title', value, $edit: edit, onChange: cb('c0'), onSubmit: cb('c1') })
    const { onEvent, rerender } = view(raw('', 0))
    const input = screen.getByLabelText<HTMLInputElement>('Title')
    fireEvent.change(input, { target: { value: 'a' } })
    fireEvent.change(input, { target: { value: 'ab' } })
    // The guest lags: its render has seen edit 1 while the person has typed two.
    rerender(raw('a', 1))
    expect(input.value).toBe('ab')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onEvent.mock.calls).toEqual([
      ['c0', ['a'], { edit: 1 }],
      ['c0', ['ab'], { edit: 2 }],
      ['c1', ['ab']]
    ])
    rerender(raw('ab', 2))
    expect(input.value).toBe('ab')
    rerender(raw('', 2))
    expect(input.value).toBe('')
  })
})
