/**
 * @vitest-environment happy-dom
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_WORKSPACE_STATUSES } from '../../../../shared/workspace-statuses'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const shortcutLabelMock = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: shortcutLabelMock }))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuRadioGroup: (props: { children?: React.ReactNode }) => <div>{props.children}</div>,
  DropdownMenuRadioItem: (props: { children?: React.ReactNode; value?: string }) => (
    <div data-testid="status-item" data-value={props.value}>
      {props.children}
    </div>
  ),
  DropdownMenuShortcut: (props: { children?: React.ReactNode }) => (
    <span data-testid="status-shortcut">{props.children}</span>
  ),
  DropdownMenuSub: (props: { children?: React.ReactNode }) => <div>{props.children}</div>,
  DropdownMenuSubContent: (props: { children?: React.ReactNode }) => <div>{props.children}</div>,
  DropdownMenuSubTrigger: (props: { children?: React.ReactNode }) => <div>{props.children}</div>
}))

const { WorktreeStatusMenuItems } = await import('./WorktreeStatusMenuItems')

let container: HTMLDivElement
let root: Root

function render(contextWorkspaceStatus: string, markDoneShortcutApplies = true): void {
  act(() =>
    root.render(
      <WorktreeStatusMenuItems
        contextWorkspaceStatus={contextWorkspaceStatus}
        deletingContext={false}
        isMultiContext={false}
        markDoneShortcutApplies={markDoneShortcutApplies}
        onAssignWorkspaceStatus={() => {}}
        workspaceStatuses={DEFAULT_WORKSPACE_STATUSES}
      />
    )
  )
}

function shortcutOnStatus(statusId: string): string | null | undefined {
  return container
    .querySelector(`[data-testid="status-item"][data-value="${statusId}"]`)
    ?.querySelector('[data-testid="status-shortcut"]')?.textContent
}

beforeEach(() => {
  shortcutLabelMock.mockReturnValue('⌫')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
  shortcutLabelMock.mockReset()
})

describe('Move to Status submenu', () => {
  it('advertises the mark-Done shortcut on Done when the key applies', () => {
    render('in-progress')

    expect(shortcutLabelMock).toHaveBeenCalledWith('workspace.markDone')
    expect(shortcutOnStatus('completed')).toBe('⌫')
    expect(shortcutOnStatus('in-review')).toBeUndefined()
  })

  it('hides the shortcut when the key would not move these rows', () => {
    render('in-progress', false)

    expect(shortcutOnStatus('completed')).toBeUndefined()
  })

  it('hides the shortcut when the user unbound it', () => {
    shortcutLabelMock.mockReturnValue(null)
    render('in-progress')

    expect(shortcutOnStatus('completed')).toBeUndefined()
  })
})
