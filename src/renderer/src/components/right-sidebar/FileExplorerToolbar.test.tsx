import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { FileExplorerToolbar } from './FileExplorerToolbar'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuCheckboxItem: () => null,
  DropdownMenuContent: () => null,
  DropdownMenuSeparator: () => null,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/sidebar/WorktreeOpenInMenu', () => ({
  WorktreeOpenInMenuItems: () => null
}))

const baseRefresh = { isRefreshing: false, showRefreshSpinner: false, handleRefresh: vi.fn() }

describe('FileExplorerToolbar', () => {
  it('shows the POSIX root path in the label tooltip for a WSL repo', () => {
    const markup = renderToStaticMarkup(
      <FileExplorerToolbar
        repoName="app"
        rootPath="/home/u/app"
        worktreePath="\\\\wsl.localhost\\Ubuntu\\home\\u\\app"
        refresh={baseRefresh}
        canRefresh={true}
        canCollapseAll={true}
        onCollapseAll={vi.fn()}
        showGitIgnoredFilesToggle={false}
        showGitIgnoredFiles={false}
        onToggleGitIgnoredFiles={vi.fn()}
        showDotfiles={false}
        onToggleDotfiles={vi.fn()}
      />
    )

    expect(markup).toContain('title="/home/u/app"')
    expect(markup).toContain('>app<')
  })

  it('falls back to the label text when there is no root path', () => {
    const markup = renderToStaticMarkup(
      <FileExplorerToolbar
        repoName="app"
        rootPath=""
        worktreePath="C:\\Users\\u\\app"
        refresh={baseRefresh}
        canRefresh={true}
        canCollapseAll={true}
        onCollapseAll={vi.fn()}
        showGitIgnoredFilesToggle={false}
        showGitIgnoredFiles={false}
        onToggleGitIgnoredFiles={vi.fn()}
        showDotfiles={false}
        onToggleDotfiles={vi.fn()}
      />
    )

    expect(markup).toContain('title="app"')
  })
})
