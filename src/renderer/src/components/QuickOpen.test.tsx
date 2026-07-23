// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import QuickOpen from './QuickOpen'

const mocks = vi.hoisted(() => ({
  captureReturnFocus: vi.fn(),
  closeModal: vi.fn(),
  openFile: vi.fn(),
  openFileAtLocation: vi.fn(),
  skipReturnFocus: vi.fn()
}))

const storeState = {
  activeModal: 'quick-open',
  activeWorktreeId: 'worktree-1',
  closeModal: mocks.closeModal,
  openFile: mocks.openFile,
  openFileAtLocation: mocks.openFileAtLocation
}

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState)
}))

vi.mock('@/store/selectors', () => ({
  useActiveWorktree: () => ({ id: 'worktree-1', path: '/repo' })
}))

vi.mock('@/components/quick-open-file-list', () => ({
  useRuntimeFileListForWorktree: () => ({
    files: ['src/components/Button.tsx', 'src/routes/About.tsx'],
    loading: false,
    loadError: null
  })
}))

vi.mock('@/hooks/useModalReturnFocus', () => ({
  useModalReturnFocus: () => ({
    captureReturnFocus: mocks.captureReturnFocus,
    skipReturnFocus: mocks.skipReturnFocus
  })
}))

vi.mock('@/components/ui/command', () => ({
  CommandDialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  CommandEmpty: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandInput: ({
    onValueChange,
    value
  }: {
    onValueChange: (value: string) => void
    value: string
  }) => (
    <input
      data-quick-open-input
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    />
  ),
  CommandItem: ({
    children,
    onSelect,
    value
  }: {
    children: ReactNode
    onSelect: () => void
    value: string
  }) => (
    <button data-command-value={value} onClick={onSelect} type="button">
      {children}
    </button>
  ),
  CommandList: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('@/lib/file-type-icons', () => ({
  getFileTypeIcon: () =>
    function FileIcon(): ReactNode {
      return <span />
    }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

describe('QuickOpen line navigation', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(<QuickOpen />)
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    document.body.replaceChildren()
  })

  it('opens the selected ranked result at the current query line and column', async () => {
    const input = container.querySelector<HTMLInputElement>('[data-quick-open-input]')
    expect(input).not.toBeNull()

    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(input, 'src/components/Button.tsx:12:7')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })

    const result = container.querySelector<HTMLButtonElement>(
      '[data-command-value="src/components/Button.tsx"]'
    )
    expect(result).not.toBeNull()

    await act(async () => {
      result?.click()
    })

    expect(mocks.openFileAtLocation).toHaveBeenCalledWith(
      {
        filePath: '/repo/src/components/Button.tsx',
        relativePath: 'src/components/Button.tsx',
        worktreeId: 'worktree-1',
        language: 'typescript',
        mode: 'edit'
      },
      { line: 12, column: 7 }
    )
    expect(mocks.openFile).not.toHaveBeenCalled()
    expect(mocks.closeModal).toHaveBeenCalledOnce()
    expect(mocks.skipReturnFocus).toHaveBeenCalledOnce()
  })
})
