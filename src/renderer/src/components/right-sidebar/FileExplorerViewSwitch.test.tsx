import { describe, expect, it, vi } from 'vitest'
import { FileExplorerViewSwitch } from './FileExplorerViewSwitch'
import { visit, type ReactElementLike } from './file-explorer-element-tree-test-harness'

function findElementByAriaLabel(node: unknown, ariaLabel: string): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (entry.props['aria-label'] === ariaLabel) {
      found = entry
    }
  })
  if (!found) {
    throw new Error(`${ariaLabel} element not found`)
  }
  return found
}

describe('FileExplorerViewSwitch', () => {
  it('switches between files and search views', () => {
    const onSelectView = vi.fn()
    const element = FileExplorerViewSwitch({
      view: 'files',
      onSelectView
    })

    const switchRoot = findElementByAriaLabel(element, 'Explorer search mode')
    ;(switchRoot.props.onValueChange as (value: string) => void)('search')

    expect(onSelectView).toHaveBeenCalledWith('search')
  })

  it('renders names and contents labels', () => {
    const element = FileExplorerViewSwitch({
      view: 'search',
      onSelectView: vi.fn()
    })

    const contentsTab = findElementByAriaLabel(element, 'Search file contents')
    const namesTab = findElementByAriaLabel(element, 'Filter files by name')
    const switchRoot = findElementByAriaLabel(element, 'Explorer search mode')

    expect(switchRoot.props.value).toBe('search')
    expect(contentsTab.props.value).toBe('search')
    expect(namesTab.props.value).toBe('files')
    expect(JSON.stringify(contentsTab.props.children)).toContain('Contents')
    expect(JSON.stringify(namesTab.props.children)).toContain('Names')
  })
})
