import { describe, expect, it, vi } from 'vitest'
import { List, ListTree } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SourceControlViewModeToggle } from './SourceControlViewModeToggle'

type ReactElementLike = { type: unknown; props: Record<string, unknown> }

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

function hasElementOfType(node: unknown, type: unknown): boolean {
  let found = false
  visit(node, (entry) => {
    if (entry.type === type) {
      found = true
    }
  })
  return found
}

describe('SourceControlViewModeToggle', () => {
  it('labels the action switch-to-tree and shows the tree icon in list mode', () => {
    const onToggle = vi.fn()
    const node = SourceControlViewModeToggle({ viewMode: 'list', onToggle })
    const button = findInnerButton(node)

    expect(button.props['aria-label']).toBe('Show changes as tree')
    expect(button.props.disabled).toBeFalsy()
    expect(hasElementOfType(node, ListTree)).toBe(true)
    ;(button.props.onClick as () => void)()
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('labels the action switch-to-list and shows the list icon in tree mode', () => {
    const node = SourceControlViewModeToggle({ viewMode: 'tree', onToggle: vi.fn() })
    const button = findInnerButton(node)

    expect(button.props['aria-label']).toBe('Show changes as list')
    expect(hasElementOfType(node, List)).toBe(true)
  })

  it('renders disabled before settings hydrate', () => {
    const node = SourceControlViewModeToggle({
      viewMode: 'list',
      disabled: true,
      onToggle: vi.fn()
    })
    const button = findInnerButton(node)

    expect(button.props.disabled).toBe(true)
  })
})
