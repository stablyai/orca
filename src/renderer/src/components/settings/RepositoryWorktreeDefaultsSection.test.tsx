// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings, Repo } from '../../../../shared/types'
import { RepositoryWorktreeDefaultsSection } from './RepositoryWorktreeDefaultsSection'

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))

vi.mock('./BaseRefPicker', () => ({
  BaseRefPicker: () => null
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
  updateRepo: (repoId: string, updates: object) => void,
  settings: Pick<GlobalSettings, 'workspaceDir' | 'worktreeCreateTimeouts'> | null = null
): void {
  act(() => {
    root.render(
      React.createElement(RepositoryWorktreeDefaultsSection, {
        repo,
        settings,
        updateRepo,
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

function getTimeoutInputs(): HTMLInputElement[] {
  return Array.from(container.querySelectorAll<HTMLInputElement>('input[type="number"]'))
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

describe('RepositoryWorktreeDefaultsSection — creation timeouts', () => {
  it('shows the execution host global values as inherited placeholders', () => {
    render(BASE_REPO, vi.fn(), {
      workspaceDir: '/tmp',
      worktreeCreateTimeouts: {
        refreshBaseRefMs: 11_000,
        addCheckoutMs: 22_000,
        registrationMs: 33_000,
        materializationMs: 44_000
      }
    })

    expect(getTimeoutInputs().map((input) => input.placeholder)).toEqual(['11', '22', '33', '44'])
  })

  it('converts seconds to milliseconds and preserves rapid field edits', () => {
    const updateRepo = vi.fn()
    render(BASE_REPO, updateRepo)
    const [refreshInput, addInput] = getTimeoutInputs()

    typeText(refreshInput, '12')
    blurInput(refreshInput)
    typeText(addInput, '34')
    blurInput(addInput)

    expect(updateRepo).toHaveBeenNthCalledWith(1, 'repo-1', {
      worktreeCreateTimeouts: { refreshBaseRefMs: 12_000 }
    })
    expect(updateRepo).toHaveBeenNthCalledWith(2, 'repo-1', {
      worktreeCreateTimeouts: { refreshBaseRefMs: 12_000, addCheckoutMs: 34_000 }
    })
  })

  it('clamps an override to the supported range', () => {
    const updateRepo = vi.fn()
    render(BASE_REPO, updateRepo)
    const [refreshInput] = getTimeoutInputs()

    typeText(refreshInput, '9999')
    blurInput(refreshInput)

    expect(updateRepo).toHaveBeenCalledWith('repo-1', {
      worktreeCreateTimeouts: { refreshBaseRefMs: 7_200_000 }
    })
  })

  it('clears the final field back to global inheritance', () => {
    const updateRepo = vi.fn()
    render(
      {
        ...BASE_REPO,
        worktreeCreateTimeouts: { registrationMs: 45_000 }
      },
      updateRepo
    )
    const registrationInput = getTimeoutInputs()[2]

    typeText(registrationInput, '')
    blurInput(registrationInput)

    expect(updateRepo).toHaveBeenCalledWith('repo-1', { worktreeCreateTimeouts: null })
  })

  it('clears every project override from Use Global', () => {
    const updateRepo = vi.fn()
    render(
      {
        ...BASE_REPO,
        worktreeCreateTimeouts: { registrationMs: 45_000 }
      },
      updateRepo
    )

    const useGlobalButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Use Global'
    )
    expect(useGlobalButton).toBeDefined()
    act(() => {
      useGlobalButton?.click()
    })

    expect(updateRepo).toHaveBeenCalledWith('repo-1', { worktreeCreateTimeouts: null })
  })

  it('does not claim a desktop global value for a runtime-owned project', () => {
    render({ ...BASE_REPO, executionHostId: 'runtime:builder' }, vi.fn(), {
      workspaceDir: '/tmp',
      worktreeCreateTimeouts: {
        refreshBaseRefMs: 11_000,
        addCheckoutMs: 22_000,
        registrationMs: 33_000,
        materializationMs: 44_000
      }
    })

    expect(getTimeoutInputs().map((input) => input.placeholder)).toEqual([
      'Host default',
      'Host default',
      'Host default',
      'Host default'
    ])
  })
})
