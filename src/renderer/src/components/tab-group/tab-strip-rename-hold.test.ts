// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { requestTerminalTabRename } from '../tab-bar/terminal-tab-rename-request'
import { useTabStripRenameHold } from './tab-strip-rename-hold'

const stripRow = document.createElement('div')
document.body.appendChild(stripRow)

function mountRenameInput(): HTMLInputElement {
  const input = document.createElement('input')
  input.setAttribute('data-tab-rename-input', 'true')
  stripRow.appendChild(input)
  return input
}

function renderHold(ownsTab: (tabId: string) => boolean) {
  const rendered = renderHook(() => useTabStripRenameHold({ enabled: true, ownsTab }))
  act(() => rendered.result.current.setStripRowNode(stripRow))
  return rendered
}

/** MutationObserver delivers on a microtask. */
async function flushObserver(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

afterEach(async () => {
  await act(async () => {
    stripRow.replaceChildren()
    await Promise.resolve()
  })
})

describe('useTabStripRenameHold', () => {
  it('holds for a requested rename of its own tab until the input unmounts', async () => {
    const { result } = renderHold((tabId) => tabId === 'tab-1')
    expect(result.current.renameActive).toBe(false)

    let input: HTMLInputElement | null = null
    act(() => {
      // The tab mounts its input in the same commit that answers the request.
      input = mountRenameInput()
      requestTerminalTabRename('tab-1')
    })
    expect(result.current.renameActive).toBe(true)

    await act(async () => {
      input?.remove()
      await Promise.resolve()
    })
    expect(result.current.renameActive).toBe(false)
  })

  it('holds for an editor opened without a request, as a double-click or the context menu do', async () => {
    const { result } = renderHold(() => false)

    act(() => {
      mountRenameInput()
    })
    await flushObserver()

    expect(result.current.renameActive).toBe(true)
  })

  it('ignores a request addressed to another group', () => {
    const { result } = renderHold(() => false)

    act(() => requestTerminalTabRename('tab-9'))

    expect(result.current.renameActive).toBe(false)
  })

  it('releases at once when no tab answered the request', () => {
    const { result } = renderHold(() => true)

    act(() => requestTerminalTabRename('tab-1'))

    expect(result.current.renameActive).toBe(false)
  })
})
