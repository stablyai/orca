// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RepoSettingsDraftInput } from './RepositorySettingsDraftInput'

let container: HTMLDivElement
let root: Root
let unmounted: boolean

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  unmounted = false
})

afterEach(() => {
  if (!unmounted) {
    act(() => {
      root.unmount()
    })
  }
  container.remove()
})

// Unmount explicitly to observe mid-composition flush; afterEach must skip a second unmount.
function unmountNow(): void {
  act(() => {
    root.unmount()
  })
  unmounted = true
}

// React onBlur delegates through bubbling focusout.
function blurInput(): void {
  act(() => {
    getInput().dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
}

function render(
  props: {
    repoId: string
    storeValue: string
    onTextChange: (text: string) => void
  },
  options?: { strict?: boolean }
): void {
  const element = React.createElement(RepoSettingsDraftInput, props)
  act(() => {
    root.render(options?.strict ? React.createElement(React.StrictMode, null, element) : element)
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
  // Use the native setter so React’s controlled-value tracker recognizes the input.
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

// Model unconfirmed IME text between compositionstart and compositionend.
function composingInput(text: string): void {
  typeText(text)
}

function compositionEnd(text: string, options?: { trailingInput?: boolean }): void {
  act(() => {
    const input = getInput()
    setNativeValue(input, text)
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: text }))
    // Model IMEs that emit final input after compositionend to verify single persistence.
    if (options?.trailingInput !== false) {
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
  })
}

describe('RepoSettingsDraftInput', () => {
  it('keeps draft text on a stale echo when React runs state updaters twice', () => {
    const onTextChange = vi.fn()
    render({ repoId: 'repo-1', storeValue: '', onTextChange }, { strict: true })

    typeText('가')
    typeText('가나')
    render({ repoId: 'repo-1', storeValue: '가', onTextChange }, { strict: true })

    expect(getInput().value).toBe('가나')
  })

  it('does not persist unconfirmed IME text while composing', () => {
    const onTextChange = vi.fn()
    render({ repoId: 'repo-1', storeValue: '', onTextChange })

    compositionStart()
    composingInput('にほんご')
    composingInput('日本語')

    // Unconfirmed persistence echoes can cancel the IME session.
    expect(onTextChange).not.toHaveBeenCalled()
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

  it('flushes an abandoned IME composition on blur', () => {
    const onTextChange = vi.fn()
    render({ repoId: 'repo-1', storeValue: '', onTextChange })

    // Blur without compositionend must still save the unconfirmed last syllable.
    compositionStart()
    composingInput('홍')
    expect(onTextChange).not.toHaveBeenCalled()

    blurInput()

    expect(onTextChange).toHaveBeenCalledTimes(1)
    expect(onTextChange).toHaveBeenCalledWith('홍')
  })

  it('flushes an abandoned IME composition when the field unmounts', () => {
    const onTextChange = vi.fn()
    render({ repoId: 'repo-1', storeValue: '', onTextChange })

    // Navigation can unmount before compositionend; retain the visible syllable.
    compositionStart()
    composingInput('홍')
    expect(onTextChange).not.toHaveBeenCalled()

    unmountNow()

    expect(onTextChange).toHaveBeenCalledTimes(1)
    expect(onTextChange).toHaveBeenCalledWith('홍')
  })
})
