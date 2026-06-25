// @vitest-environment happy-dom
import { createRoot, type Root } from 'react-dom/client'
import { act, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceStatusDefinition } from '../../../../shared/types'

const statuses: WorkspaceStatusDefinition[] = [{ id: 'todo', label: 'Todo' }]
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

import WorkspaceKanbanSettingsMenu from './WorkspaceKanbanSettingsMenu'

let root: Root | null = null
let container: HTMLDivElement | null = null

function renderMenu(onSyncTaskStatusFromWorkspaceBoardChange = vi.fn()): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <WorkspaceKanbanSettingsMenu
        workspaceStatuses={statuses}
        syncTaskStatusFromWorkspaceBoard={false}
        onSyncTaskStatusFromWorkspaceBoardChange={onSyncTaskStatusFromWorkspaceBoardChange}
        onRenameStatus={vi.fn()}
        onChangeStatusColor={vi.fn()}
        onChangeStatusIcon={vi.fn()}
        onMoveStatus={vi.fn()}
        onRemoveStatus={vi.fn()}
        onAddStatus={vi.fn()}
      />
    )
  })
}

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  root = null
  container?.remove()
  container = null
  document.body.innerHTML = ''
})

describe('WorkspaceKanbanSettingsMenu', () => {
  it('renders the task status sync switch and forwards changes', async () => {
    const onChange = vi.fn()
    renderMenu(onChange)

    const toggle = document.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="Sync board and issue status"]'
    )
    expect(toggle).not.toBeNull()
    expect(toggle?.getAttribute('aria-checked')).toBe('false')

    await act(async () => {
      toggle?.click()
      await Promise.resolve()
    })

    expect(onChange).toHaveBeenCalledWith(true)
  })
})
