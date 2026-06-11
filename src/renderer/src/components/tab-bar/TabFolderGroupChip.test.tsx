import { renderToStaticMarkup } from 'react-dom/server'
import type React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { TabFolderGroupChip } from './TabFolderGroupChip'

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />
}))

describe('TabFolderGroupChip', () => {
  it('renders the collapsed group label and member count', () => {
    const html = renderToStaticMarkup(
      <TabFolderGroupChip
        group={{
          id: 'folder-1',
          worktreeId: 'wt-1',
          splitGroupId: 'split-1',
          name: 'Review',
          color: 'var(--color-blue-500)',
          collapsed: true,
          tabOrder: ['tab-1', 'tab-2', 'tab-3'],
          sortOrder: 0,
          createdAt: 1
        }}
        memberCount={3}
        onToggleCollapsed={() => {}}
        onRename={() => {}}
        onChangeColor={() => {}}
        onUngroup={() => {}}
        onCloseAll={() => {}}
      />
    )

    expect(html).toContain('Review')
    expect(html).toContain('3')
    expect(html).toContain('Review tab group, 3 tabs')
  })
})
