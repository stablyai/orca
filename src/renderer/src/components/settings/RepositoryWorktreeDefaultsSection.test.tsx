// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { RepositoryWorktreeDefaultsSection } from './RepositoryWorktreeDefaultsSection'

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))

vi.mock('./BaseRefPicker', () => ({
  BaseRefPicker: () => null
}))

vi.mock('../ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children
  }: {
    value: string
    onValueChange: (value: string) => void
    children: React.ReactNode
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.currentTarget.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  )
}))

const BASE_REPO: Repo = {
  id: 'repo-1',
  path: '/home/user/project',
  displayName: 'My Project',
  badgeColor: '#000000',
  addedAt: 0
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

function render(
  repo: Repo,
  updateRepo: (repoId: string, updates: object) => void | Promise<boolean>,
  options: {
    settings?: Pick<GlobalSettings, 'workspaceDir' | 'worktreeVisibilityDefaults'> | null
    refreshRepo?: (repoId: string) => void | Promise<unknown>
  } = {}
): void {
  act(() => {
    root.render(
      React.createElement(RepositoryWorktreeDefaultsSection, {
        repo,
        settings: options.settings ?? null,
        updateRepo,
        refreshRepo: options.refreshRepo ?? (() => {}),
        forceVisible: true
      })
    )
  })
}

function getWorktreePathInput(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input')
  if (!input) {
    throw new Error('worktree path input not found')
  }
  return input
}

function setNativeValue(input: HTMLInputElement, text: string): void {
  // Why: React reads controlled-input changes via the native value setter;
  // assigning input.value directly is swallowed by React's value tracking.
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setValue?.call(input, text)
}

function typeText(input: HTMLInputElement, text: string): void {
  act(() => {
    setNativeValue(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function blurInput(input: HTMLInputElement): void {
  // Why: React delegates onBlur via focusout (which bubbles) not blur (which
  // doesn't), so dispatching focusout is required to trigger the React handler.
  act(() => {
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
}

describe('RepositoryWorktreeDefaultsSection — worktree path', () => {
  it('does not call updateRepo while the user is typing', () => {
    const updateRepo = vi.fn()
    render(BASE_REPO, updateRepo)

    const input = getWorktreePathInput()
    typeText(input, './w')
    typeText(input, './wo')
    typeText(input, './wor')
    typeText(input, './worktree')

    expect(updateRepo).not.toHaveBeenCalled()
  })

  it('calls updateRepo with the final value on blur', () => {
    const updateRepo = vi.fn()
    render(BASE_REPO, updateRepo)

    const input = getWorktreePathInput()
    typeText(input, '  ./worktree  ')
    blurInput(input)

    expect(updateRepo).toHaveBeenCalledTimes(1)
    expect(updateRepo).toHaveBeenCalledWith('repo-1', { worktreeBasePath: './worktree' })
  })

  it('does not call updateRepo when the normalized value is unchanged on blur', () => {
    const updateRepo = vi.fn()
    render({ ...BASE_REPO, worktreeBasePath: './worktree' }, updateRepo)

    const input = getWorktreePathInput()
    typeText(input, '  ./worktree  ')
    blurInput(input)

    expect(updateRepo).not.toHaveBeenCalled()
  })

  it('calls updateRepo with undefined when the field is cleared', () => {
    const updateRepo = vi.fn()
    render({ ...BASE_REPO, worktreeBasePath: '../worktrees' }, updateRepo)

    const input = getWorktreePathInput()
    typeText(input, '')
    blurInput(input)

    expect(updateRepo).toHaveBeenCalledWith('repo-1', { worktreeBasePath: undefined })
  })

  it('calls updateRepo with undefined when the value is whitespace-only', () => {
    const updateRepo = vi.fn()
    render({ ...BASE_REPO, worktreeBasePath: '../worktrees' }, updateRepo)

    const input = getWorktreePathInput()
    typeText(input, '   ')
    blurInput(input)

    expect(updateRepo).toHaveBeenCalledWith('repo-1', { worktreeBasePath: undefined })
  })
})

describe('RepositoryWorktreeDefaultsSection — external visibility', () => {
  it('shows the inherited effective value without stamping the repo', () => {
    render(BASE_REPO, vi.fn(), {
      settings: {
        workspaceDir: '/home/user/orca/workspaces',
        worktreeVisibilityDefaults: { external: 'show' }
      }
    })

    expect(container.textContent).toContain('Using global: Show')
    expect(container.querySelector('select')?.value).toBe('global')
  })

  it('clears the override with the remote-safe null sentinel and refreshes classification', async () => {
    const updateRepo = vi.fn().mockResolvedValue(true)
    const refreshRepo = vi.fn().mockResolvedValue(true)
    render({ ...BASE_REPO, externalWorktreeVisibility: 'show' }, updateRepo, { refreshRepo })

    await act(async () => {
      const select = container.querySelector('select')!
      select.value = 'global'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(updateRepo).toHaveBeenCalledWith('repo-1', { externalWorktreeVisibility: null })
    expect(refreshRepo).toHaveBeenCalledWith('repo-1')
  })

  it('falls back to the effective explicit value when an older host rejects inheritance', async () => {
    const updateRepo = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    render(
      {
        ...BASE_REPO,
        externalWorktreeVisibility: 'show',
        externalWorktreeVisibilityLegacy: false
      },
      updateRepo
    )

    await act(async () => {
      const select = container.querySelector('select')!
      select.value = 'global'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(updateRepo).toHaveBeenNthCalledWith(2, 'repo-1', {
      externalWorktreeVisibility: 'show'
    })
  })
})
