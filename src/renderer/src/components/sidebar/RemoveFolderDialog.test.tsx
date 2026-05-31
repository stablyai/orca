import { renderToStaticMarkup } from 'react-dom/server'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state = {
    activeModal: 'confirm-remove-folder',
    modalData: {} as Record<string, unknown>,
    closeModal: vi.fn(),
    removeProject: vi.fn()
  }
  return { state }
})

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state)
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) => (
    <button {...props}>{children}</button>
  )
}))

vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

describe('RemoveFolderDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.activeModal = 'confirm-remove-folder'
    mocks.state.modalData = {}
  })

  it('renders batch project removal copy without implying disk deletion', async () => {
    mocks.state.modalData = {
      repoIds: ['repo-1', 'repo-2'],
      displayNames: ['Orca', 'Noqa']
    }

    const { default: RemoveFolderDialog } = await import('./RemoveFolderDialog')
    const markup = renderToStaticMarkup(<RemoveFolderDialog />)

    expect(markup).toContain('Remove Projects')
    expect(markup).toContain('2 projects')
    expect(markup).toContain('Their folders and git worktrees stay on disk.')
    expect(markup).toContain('Orca')
    expect(markup).toContain('Noqa')
    expect(markup).not.toContain('delete')
  })
})
