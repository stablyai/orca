import { describe, expect, it, vi } from 'vitest'
import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FileExplorerToolbar } from './FileExplorerToolbar'

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

function findRefreshButton(node: unknown): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (entry.type === Button && entry.props['aria-label'] === 'Refresh Explorer') {
      found = entry
    }
  })
  if (!found) {
    throw new Error('refresh button not found')
  }
  return found
}

function findRepoNameLabel(node: unknown, repoName: string): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (entry.type === 'span' && entry.props.title === repoName) {
      found = entry
    }
  })
  if (!found) {
    throw new Error('repo name label not found')
  }
  return found
}

function hasIcon(node: unknown, icon: unknown): boolean {
  let found = false
  visit(node, (entry) => {
    if (entry.type === icon) {
      found = true
    }
  })
  return found
}

function makeRefreshState(
  overrides: Partial<{
    isRefreshing: boolean
    showRefreshSpinner: boolean
    handleRefresh: () => void
  }> = {}
) {
  return {
    isRefreshing: false,
    showRefreshSpinner: false,
    handleRefresh: vi.fn(),
    ...overrides
  }
}

describe('FileExplorerToolbar', () => {
  it('fires the refresh action from the icon button', () => {
    const onRefresh = vi.fn()
    const element = FileExplorerToolbar({
      repoName: 'orca',
      refresh: makeRefreshState({ handleRefresh: onRefresh })
    })

    const button = findRefreshButton(element)
    ;(button.props.onClick as () => void)()

    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(button.props.disabled).toBe(false)
    expect(hasIcon(button, RefreshCw)).toBe(true)
    expect(hasIcon(button, Loader2)).toBe(false)
  })

  it('shows the repo name in a truncated label', () => {
    const repoName = 'really-long-repo-name-that-should-not-push-refresh-offscreen'
    const element = FileExplorerToolbar({
      repoName,
      refresh: makeRefreshState()
    })

    const label = findRepoNameLabel(element, repoName)

    expect(label.props.children).toBe(repoName)
    expect(label.props.className).toContain('truncate')
    expect(label.props.className).toContain('min-w-0')
  })

  it('disables the refresh button and shows a spinner while refreshing', () => {
    const element = FileExplorerToolbar({
      repoName: 'orca',
      refresh: makeRefreshState({ isRefreshing: true, showRefreshSpinner: true })
    })

    const button = findRefreshButton(element)

    expect(button.props.disabled).toBe(true)
    expect(hasIcon(button, Loader2)).toBe(true)
    expect(hasIcon(button, RefreshCw)).toBe(false)
  })
})
