// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { Worktree } from '../../../shared/worktree/types'
import QuickOpen from './QuickOpen'

const literalInput = vi.hoisted((): { onValueChange?: (value: string) => void } => ({}))
const pathExistsMock = vi.hoisted(() => vi.fn<(path: string) => Promise<boolean>>())
const openDetectedFilePathMock = vi.hoisted(() => vi.fn())

vi.mock('@/components/quick-open-file-list', () => ({
  useRuntimeFileListForWorktree: () => ({
    files: [],
    loading: false,
    loadError: null,
    truncated: false
  })
}))

vi.mock('@/hooks/useModalReturnFocus', () => ({
  useModalReturnFocus: () => ({ captureReturnFocus: vi.fn(), skipReturnFocus: vi.fn() })
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, string | number>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? ''))
}))

vi.mock('@/components/terminal-pane/terminal-file-open-routing', () => ({
  openDetectedFilePath: openDetectedFilePathMock
}))

vi.mock('@/components/right-sidebar/file-explorer-operation-owner', () => ({
  getFileExplorerOperationOwner: () => ({ kind: 'local' }),
  getFileExplorerOperationRoute: () => ({ settings: { activeRuntimeEnvironmentId: null } })
}))

vi.mock('@/runtime/runtime-file-client', () => ({
  isRemoteRuntimeFileOperation: () => false
}))

vi.mock('@/runtime/runtime-path-existence-batch', () => ({
  runtimePathsExist: vi.fn()
}))

vi.mock('@/components/ui/command', () => ({
  CommandDialog: ({ children, open }: { children: ReactNode; open?: boolean }) =>
    open ? <div data-command-dialog="true">{children}</div> : null,
  CommandInput: (props: { value?: string; onValueChange?: (value: string) => void }) => {
    literalInput.onValueChange = props.onValueChange
    return <input data-command-input="true" value={props.value ?? ''} readOnly />
  },
  CommandList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandEmpty: ({ children }: { children: ReactNode }) => <div data-empty="true">{children}</div>,
  CommandItem: (props: { value?: string; children: ReactNode; onSelect?: () => void }) => (
    <div data-item-value={String(props.value ?? '')} onClick={props.onSelect}>
      {props.children}
    </div>
  )
}))

const initialAppState = useAppStore.getInitialState()

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    repoId: 'repo-local',
    path: '/repo',
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: true,
    displayName: 'Local',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function typeQuery(value: string): void {
  act(() => {
    literalInput.onValueChange?.(value)
  })
}

function pinnedRow(): HTMLElement | null {
  return document.querySelector('[data-item-value^="/"]')
}

async function settle(ms = 60): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  await act(async () => {
    await promise
  })
}

describe('QuickOpen literal path row', () => {
  beforeEach(() => {
    pathExistsMock.mockReset()
    openDetectedFilePathMock.mockReset()
    pathExistsMock.mockResolvedValue(true)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { shell: { pathExists: pathExistsMock } }
    })
    useAppStore.setState(initialAppState, true)
    useAppStore.setState(
      {
        activeModal: 'quick-open',
        activeWorktreeId: 'wt-1',
        worktreesByRepo: { 'repo-local': [makeWorktree()] }
      }
      // SAFETY: store slice partial seeded with the fields QuickOpen reads.
    )
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialAppState, true)
  })

  it('shows the pinned Open row only after the existence check confirms the file', async () => {
    render(<QuickOpen />)

    const gate = Promise.withResolvers<boolean>()
    pathExistsMock.mockImplementationOnce(() => gate.promise)
    typeQuery('/notes.md')

    await waitFor(() => expect(pathExistsMock).toHaveBeenCalledWith('/notes.md'))
    expect(pinnedRow()).toBeNull()

    await act(async () => gate.resolve(true))
    await waitFor(() => expect(pinnedRow()).not.toBeNull())
    expect(pinnedRow()?.textContent).toContain('Open /notes.md')
  })

  it('never shows the row when the host reports the path missing', async () => {
    pathExistsMock.mockResolvedValue(false)
    render(<QuickOpen />)
    typeQuery('/absent.md')

    await waitFor(() => expect(pathExistsMock).toHaveBeenCalledWith('/absent.md'))
    await settle()
    expect(pinnedRow()).toBeNull()
  })

  it('skips the existence check for bare fuzzy queries', async () => {
    render(<QuickOpen />)
    typeQuery('auth.ts')

    await settle()
    expect(pathExistsMock).not.toHaveBeenCalled()
    expect(pinnedRow()).toBeNull()
  })

  it('joins relative queries against the worktree root and carries :line into the terminal-link open flow', async () => {
    render(<QuickOpen />)
    typeQuery('src/gen.ts:42')

    await waitFor(() => expect(pathExistsMock).toHaveBeenCalledWith('/repo/src/gen.ts'))
    await waitFor(() => expect(pinnedRow()).not.toBeNull())
    const row = pinnedRow()
    if (!row) {
      throw new Error('pinned row disappeared after confirmation')
    }
    expect(row.getAttribute('data-item-value')).toBe('/repo/src/gen.ts:42')

    await act(async () => {
      fireEvent.click(row)
    })
    expect(openDetectedFilePathMock).toHaveBeenCalledWith('/repo/src/gen.ts', 42, null, {
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      runtimeEnvironmentId: null
    })
  })

  it('keeps the no-matching-files note under the pinned row', async () => {
    render(<QuickOpen />)
    typeQuery('/notes.md')

    await waitFor(() => expect(pinnedRow()).not.toBeNull())
    expect(screen.getByText('No matching files.')).toBeTruthy()
    expect(document.querySelector('[data-empty="true"]')).toBeNull()
  })
})
