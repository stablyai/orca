// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorktreeCardDisplayMenuSection } from './WorktreeCardDisplayMenuSection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const setWorktreeCardMode = vi.fn()
const setWorktreeCardProperties = vi.fn()
const setAgentActivityDisplayMode = vi.fn()

let settings = { compactWorktreeCards: false, experimentalNewWorktreeCardStyle: false }
let worktreeCardProperties = [
  'status',
  'unread',
  'issue',
  'linear-issue',
  'pr',
  'automation',
  'comment',
  'ports',
  'inline-agents'
]

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      agentActivityDisplayMode: 'compact',
      setAgentActivityDisplayMode,
      setWorktreeCardMode,
      setWorktreeCardProperties,
      settings,
      worktreeCardProperties
    })
}))

vi.mock('@/components/ui/dropdown-menu', async () => {
  const ReactModule = await import('react')
  type RadioItemProps = {
    children: ReactNode
    onSelect?: (event: { preventDefault: () => void }) => void
    onValueChange?: (value: string) => void
    value: string
  }
  return {
    DropdownMenuCheckboxItem: ({
      children,
      checked,
      onCheckedChange
    }: {
      children: ReactNode
      checked?: boolean
      onCheckedChange?: (checked: boolean) => void
    }) => (
      <button
        type="button"
        data-checked={checked ? 'true' : 'false'}
        onClick={() => onCheckedChange?.(!checked)}
      >
        {children}
      </button>
    ),
    DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DropdownMenuRadioGroup: ({
      children,
      onValueChange,
      value
    }: {
      children: ReactNode
      onValueChange?: (value: string) => void
      value?: string
    }) => (
      <div data-radio-group-value={value}>
        {ReactModule.Children.map(children, (child) =>
          ReactModule.isValidElement<RadioItemProps>(child)
            ? ReactModule.cloneElement(child, { onValueChange })
            : child
        )}
      </div>
    ),
    DropdownMenuRadioItem: ({ children, onSelect, onValueChange, value }: RadioItemProps) => (
      <button
        type="button"
        data-radio-item-value={value}
        onClick={() => {
          onSelect?.({ preventDefault: vi.fn() })
          onValueChange?.(value)
        }}
      >
        {children}
      </button>
    ),
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuSub: ({ children }: { children: ReactNode }) => <>{children}</>,
    DropdownMenuSubContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DropdownMenuSubTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>
  }
})

let root: Root | null = null
let container: HTMLDivElement | null = null

function renderMenu(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(<WorktreeCardDisplayMenuSection preserveWorkspaceBoardOpen={false} />)
  })
}

beforeEach(() => {
  settings = { compactWorktreeCards: false, experimentalNewWorktreeCardStyle: false }
  worktreeCardProperties = [
    'status',
    'unread',
    'issue',
    'linear-issue',
    'pr',
    'automation',
    'comment',
    'ports',
    'inline-agents'
  ]
  setAgentActivityDisplayMode.mockReset()
  setWorktreeCardMode.mockReset()
  setWorktreeCardProperties.mockReset()
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  root = null
  container?.remove()
  container = null
  document.body.innerHTML = ''
})

describe('WorktreeCardDisplayMenuSection', () => {
  it('applies the compact card mode preset from the visible card layout menu', () => {
    renderMenu()

    const compactLayoutButton = document.querySelector<HTMLButtonElement>(
      '[data-radio-group-value="detailed"] [data-radio-item-value="compact"]'
    )
    expect(compactLayoutButton).not.toBeNull()

    act(() => {
      compactLayoutButton?.click()
    })

    expect(setWorktreeCardMode).toHaveBeenCalledWith('Compact')
  })
})
