// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RepoSettingsDraftInput } from './RepositorySettingsDraftInput'

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

function render(props: {
  repoId: string
  storeValue: string
  onTextChange: (text: string) => void
}): void {
  act(() => {
    root.render(React.createElement(RepoSettingsDraftInput, props))
  })
}

function getInput(): HTMLInputElement {
  const input = container.querySelector('input')
  if (!input) {
    throw new Error('input not rendered')
  }
  return input
}

function typeText(text: string): void {
  act(() => {
    const input = getInput()
    // Why: React reads controlled-input changes via the native value setter;
    // assigning input.value directly is swallowed by React's value tracking.
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setValue?.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('RepoSettingsDraftInput', () => {
  it('keeps draft text while the store still holds the previous value (IME regression)', () => {
    const onTextChange = vi.fn()
    render({ repoId: 'repo-1', storeValue: '가', onTextChange })

    typeText('가나')

    // Why: updateRepo persists via async IPC, so the store re-renders the pane
    // with the stale value first. Reverting the input here is what aborted the
    // Hangul IME composition (가나다 → ㄱㅏㄴㅏㄷㅏ).
    render({ repoId: 'repo-1', storeValue: '가', onTextChange })

    expect(getInput().value).toBe('가나')
    expect(onTextChange).toHaveBeenCalledWith('가나')
  })

  it('keeps draft text when a stale store echo arrives after newer keystrokes', () => {
    const onTextChange = vi.fn()
    render({ repoId: 'repo-1', storeValue: '', onTextChange })

    typeText('가')
    typeText('가나')

    // Stale repos:changed echo of the first keystroke.
    render({ repoId: 'repo-1', storeValue: '가', onTextChange })

    expect(getInput().value).toBe('가나')
  })

  it('accepts same-repo store changes that did not come from the input draft', () => {
    const onTextChange = vi.fn()
    render({ repoId: 'repo-1', storeValue: '../custom-worktrees', onTextChange })

    render({ repoId: 'repo-1', storeValue: '', onTextChange })

    expect(getInput().value).toBe('')
  })

  it('resets the draft when the pane switches repos', () => {
    const onTextChange = vi.fn()
    render({ repoId: 'repo-1', storeValue: 'Repo One', onTextChange })

    typeText('Renamed')

    render({ repoId: 'repo-2', storeValue: 'Repo Two', onTextChange })

    expect(getInput().value).toBe('Repo Two')
  })

  it('persists every keystroke through onTextChange', () => {
    const onTextChange = vi.fn()
    render({ repoId: 'repo-1', storeValue: '', onTextChange })

    typeText('a')
    typeText('ab')

    expect(onTextChange).toHaveBeenNthCalledWith(1, 'a')
    expect(onTextChange).toHaveBeenNthCalledWith(2, 'ab')
  })
})
