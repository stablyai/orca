// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { requestTerminalTabRename } from '../tab-bar/terminal-tab-rename-request'
import { useTabStripRenameHold } from './tab-strip-rename-hold'

const panel = document.createElement('div')
document.body.appendChild(panel)

function mountRenameInput(): HTMLInputElement {
  const input = document.createElement('input')
  input.setAttribute('data-tab-rename-input', 'true')
  panel.appendChild(input)
  return input
}

function renderHold(ownsTab: (tabId: string) => boolean) {
  return renderHook(() =>
    useTabStripRenameHold({ enabled: true, panelRef: { current: panel }, ownsTab })
  )
}

afterEach(() => {
  panel.replaceChildren()
})

describe('useTabStripRenameHold', () => {
  it('holds for a rename of its own tab until the input unmounts', async () => {
    const { result } = renderHold((tabId) => tabId === 'tab-1')
    expect(result.current).toBe(false)

    let input: HTMLInputElement | null = null
    act(() => {
      // The tab mounts its input in the same commit that answers the request.
      input = mountRenameInput()
      requestTerminalTabRename('tab-1')
    })
    expect(result.current).toBe(true)

    await act(async () => {
      input?.remove()
      // MutationObserver delivers on a microtask.
      await Promise.resolve()
    })
    expect(result.current).toBe(false)
  })

  it('ignores a rename addressed to another group', () => {
    const { result } = renderHold(() => false)

    act(() => {
      mountRenameInput()
      requestTerminalTabRename('tab-9')
    })

    expect(result.current).toBe(false)
  })

  it('releases at once when the group mounted no rename input', () => {
    const { result } = renderHold(() => true)

    act(() => requestTerminalTabRename('tab-1'))

    expect(result.current).toBe(false)
  })
})
