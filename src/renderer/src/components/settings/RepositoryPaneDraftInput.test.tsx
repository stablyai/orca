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

function setNativeValue(input: HTMLInputElement, text: string): void {
  // Why: React reads controlled-input changes via the native value setter;
  // assigning input.value directly is swallowed by React's value tracking.
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setValue?.call(input, text)
}

function typeText(text: string): void {
  act(() => {
    const input = getInput()
    setNativeValue(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function compositionStart(): void {
  act(() => {
    getInput().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  })
}

// Why: an input event fired between compositionstart and compositionend models a
// keystroke of unconfirmed IME text (e.g. Japanese kana before conversion).
function composingInput(text: string): void {
  typeText(text)
}

function compositionEnd(text: string, options?: { trailingInput?: boolean }): void {
  act(() => {
    const input = getInput()
    setNativeValue(input, text)
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: text }))
    // Why: some IMEs (e.g. Firefox) emit the final input event after
    // compositionend; model it so the single-persist guard is exercised.
    if (options?.trailingInput !== false) {
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
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

  it('does not persist unconfirmed IME text while composing', () => {
    const onTextChange = vi.fn()
    render({ repoId: 'repo-1', storeValue: '', onTextChange })

    // Japanese conversion: type kana, then convert, before confirming.
    compositionStart()
    composingInput('にほんご')
    composingInput('日本語')

    // Why: persisting mid-composition writes the pre-confirmation value and its
    // async store echo can cancel the IME session.
    expect(onTextChange).not.toHaveBeenCalled()
    // The input still shows the unconfirmed text via the local draft.
    expect(getInput().value).toBe('日本語')
  })

  it('persists once with the confirmed value on compositionend', () => {
    const onTextChange = vi.fn()
    render({ repoId: 'repo-1', storeValue: '', onTextChange })

    compositionStart()
    composingInput('にほんご')
    composingInput('日本語')
    compositionEnd('日本語')

    expect(onTextChange).toHaveBeenCalledTimes(1)
    expect(onTextChange).toHaveBeenCalledWith('日本語')
    expect(getInput().value).toBe('日本語')
  })

  it('does not suppress later edits when no final input follows compositionend', () => {
    const onTextChange = vi.fn()
    render({ repoId: 'repo-1', storeValue: '', onTextChange })

    compositionStart()
    composingInput('にほんご')
    compositionEnd('日本語', { trailingInput: false })
    render({ repoId: 'repo-1', storeValue: '日本語', onTextChange })

    typeText('日本語!')

    expect(onTextChange).toHaveBeenNthCalledWith(1, '日本語')
    expect(onTextChange).toHaveBeenNthCalledWith(2, '日本語!')
  })

  it('resumes per-keystroke persistence after composition ends', () => {
    const onTextChange = vi.fn()
    render({ repoId: 'repo-1', storeValue: '', onTextChange })

    compositionStart()
    composingInput('あ')
    compositionEnd('亜')
    typeText('亜b')

    expect(onTextChange).toHaveBeenNthCalledWith(1, '亜')
    expect(onTextChange).toHaveBeenNthCalledWith(2, '亜b')
  })

  it('resets composition state when the pane switches repos', () => {
    const onTextChange = vi.fn()
    render({ repoId: 'repo-1', storeValue: '', onTextChange })

    compositionStart()
    composingInput('未確定')
    render({ repoId: 'repo-2', storeValue: 'Repo Two', onTextChange })
    typeText('Renamed Repo Two')

    expect(onTextChange).toHaveBeenCalledTimes(1)
    expect(onTextChange).toHaveBeenCalledWith('Renamed Repo Two')
  })
})
