// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parsePluginDeclarativeTree } from '../../../../../shared/plugins/declarative/plugin-declarative-tree'
import { PluginDeclarativeView } from './PluginDeclarativeView'

afterEach(cleanup)

const node = (type: string, props: Record<string, unknown> = {}, children: unknown[] = []) => ({
  type,
  props,
  children
})

function draw(raw: unknown): HTMLElement {
  const parsed = parsePluginDeclarativeTree(raw)
  if (!parsed.ok || !parsed.tree) {
    throw new Error(parsed.ok ? 'empty tree' : parsed.error)
  }
  const { container } = render(<PluginDeclarativeView tree={parsed.tree} onEvent={vi.fn()} />)
  const root = container.querySelector<HTMLElement>('[data-layout]')
  if (!root) {
    throw new Error('no Box drawn')
  }
  return root
}

describe('Box in the host view', () => {
  it('maps props to theme tokens and sizes to inline px or percent', () => {
    const root = draw(
      node(
        'Box',
        {
          direction: 'row',
          gap: 'md',
          padding: 'sm',
          paddingY: 'lg',
          border: true,
          radius: 'md',
          background: 'muted',
          width: '50%',
          minHeight: 120,
          align: 'center',
          justify: 'between',
          wrap: true,
          scroll: 'y'
        },
        ['inside']
      )
    )
    expect(root.dataset).toMatchObject({
      layout: 'row',
      gap: 'md',
      paddingX: 'sm',
      paddingY: 'lg',
      border: 'neutral',
      radius: 'md',
      background: 'muted',
      align: 'center',
      justify: 'between',
      wrap: 'true',
      scroll: 'y'
    })
    expect(root.style.width).toBe('50%')
    expect(root.style.minHeight).toBe('120px')
    expect(root.style.maxWidth).toBe('')
    expect(root.className).toContain('data-[background=muted]:bg-muted')
    expect(root.textContent).toBe('inside')
  })

  it('defaults to a borderless column, and columns switch it to a grid', () => {
    expect(draw(node('Box')).dataset).toMatchObject({
      layout: 'column',
      align: 'default',
      border: 'none',
      background: 'none',
      paddingX: 'none'
    })
    expect(draw(node('Box', { direction: 'row' })).dataset.align).toBe('center')
    cleanup()
    const grid = draw(node('Box', { columns: 3, direction: 'row', border: 'warning' }))
    expect(grid.dataset).toMatchObject({ layout: 'grid', columns: '3', border: 'warning' })
  })

  it('draws nested Boxes with their children in order', () => {
    draw(
      node('Box', { direction: 'row' }, [
        node('Box', { grow: true, background: 'card' }, [node('Text', {}, ['left'])]),
        node('Box', { shrink: false }, [node('Badge', { tone: 'success' }, ['right'])])
      ])
    )
    const boxes = document.querySelectorAll<HTMLElement>('[data-layout]')
    expect(boxes).toHaveLength(3)
    expect(boxes[1].dataset).toMatchObject({ grow: 'true', background: 'card' })
    expect(boxes[2].dataset.shrink).toBe('false')
    expect(boxes[0].textContent).toBe('leftright')
    expect(screen.getByText('right')).toBeTruthy()
  })
})
