import { describe, expect, it, vi } from 'vitest'
import { Button } from '@/components/ui/button'
import { FileExplorerNameFilter } from './FileExplorerNameFilter'
import { visit, type ReactElementLike } from './file-explorer-element-tree-test-harness'

function findInputByAriaLabel(node: unknown, ariaLabel: string): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (entry.type === 'input' && entry.props['aria-label'] === ariaLabel) {
      found = entry
    }
  })
  if (!found) {
    throw new Error(`${ariaLabel} input not found`)
  }
  return found
}

function findButtonByAriaLabel(node: unknown, ariaLabel: string): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (
      entry.props['aria-label'] === ariaLabel &&
      (entry.type === Button || entry.type === 'button')
    ) {
      found = entry
    }
  })
  if (!found) {
    throw new Error(`${ariaLabel} button not found`)
  }
  return found
}

describe('FileExplorerNameFilter', () => {
  it('reports text changes and shows the compact file filter input', () => {
    const onQueryChange = vi.fn()
    const element = FileExplorerNameFilter({
      query: '',
      onQueryChange,
      onClear: vi.fn()
    })

    const input = findInputByAriaLabel(element, 'Find files')
    ;(input.props.onChange as (event: { currentTarget: { value: string } }) => void)({
      currentTarget: { value: 'FileExplorer' }
    })

    expect(input.props.placeholder).toBe('Find files')
    expect(onQueryChange).toHaveBeenCalledWith('FileExplorer')
  })

  it('clears the current file filter from the clear button', () => {
    const onClear = vi.fn()
    const element = FileExplorerNameFilter({
      query: 'FileExplorer',
      onQueryChange: vi.fn(),
      onClear
    })

    const button = findButtonByAriaLabel(element, 'Clear file filter')
    ;(button.props.onClick as () => void)()

    expect(onClear).toHaveBeenCalledTimes(1)
  })
})
