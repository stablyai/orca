// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteFileBrowser } from './RemoteFileBrowser'

const browseDir = vi.fn(async ({ dirPath }: { dirPath: string }) => ({
  entries: [
    { name: 'docs', isDirectory: true },
    { name: 'src', isDirectory: true },
    { name: 'README.md', isDirectory: false }
  ],
  resolvedPath: dirPath === '~' ? '/home/alice' : dirPath,
  pathFlavor: 'posix' as const
}))

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve()
  }
}

async function render(): Promise<{
  container: HTMLDivElement
  input: HTMLInputElement
  root: Root
}> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<RemoteFileBrowser targetId="target-1" onSelect={vi.fn()} onCancel={vi.fn()} />)
    await flushPromises()
  })
  const input = container.querySelector('input')
  if (!input) {
    throw new Error('Remote file browser input was not rendered')
  }
  return { container, input, root }
}

async function press(
  input: HTMLInputElement,
  key: string,
  modifiers: KeyboardEventInit = {}
): Promise<void> {
  await act(async () => {
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers })
    )
    await flushPromises()
  })
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function settlePathResolve(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(300)
    await flushPromises()
  })
}

function selectedRow(container: HTMLElement): string | null | undefined {
  return container.querySelector('[role="option"][aria-selected="true"]')?.textContent
}

describe('RemoteFileBrowser keyboard navigation', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    browseDir.mockClear()
    Object.defineProperty(window, 'api', { configurable: true, value: { ssh: { browseDir } } })
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  it('highlights the first row and moves it with the arrow keys', async () => {
    const { container, input, root } = await render()
    expect(selectedRow(container)).toBe('docs')
    expect(input.getAttribute('aria-activedescendant')).toBe(
      container.querySelector('[role="option"][aria-selected="true"]')?.id
    )
    expect(input.getAttribute('role')).toBe('combobox')
    expect(input.getAttribute('aria-controls')).toBe(
      container.querySelector('[role="listbox"]')?.id
    )

    await press(input, 'ArrowDown')
    await press(input, 'ArrowDown')
    await press(input, 'ArrowDown')
    expect(selectedRow(container)).toBe('README.md')

    await press(input, 'ArrowUp')
    expect(selectedRow(container)).toBe('src')

    // Modified arrows stay with the input (selection, caret jumps).
    await press(input, 'ArrowDown', { shiftKey: true })
    expect(selectedRow(container)).toBe('src')

    await act(async () => root.unmount())
  })

  it('opens the highlighted folder on Enter', async () => {
    const { container, input, root } = await render()
    browseDir.mockClear()

    await press(input, 'ArrowDown')
    await press(input, 'Enter')

    expect(browseDir).toHaveBeenCalledWith({ targetId: 'target-1', dirPath: '/home/alice/src' })
    expect(selectedRow(container)).toBe('docs')

    await act(async () => root.unmount())
  })

  it('points the input at no row while the next listing loads', async () => {
    const { input, root } = await render()
    browseDir.mockImplementationOnce(() => new Promise(() => {}))

    await press(input, 'Enter')

    expect(input.hasAttribute('aria-activedescendant')).toBe(false)
    await act(async () => root.unmount())
  })

  // Why: the previous listing's single folder would otherwise win Enter while the next one loads.
  it('ignores Enter while the next listing loads', async () => {
    browseDir.mockImplementationOnce(async () => ({
      entries: [
        { name: 'docs', isDirectory: true },
        { name: 'README.md', isDirectory: false }
      ],
      resolvedPath: '/home/alice',
      pathFlavor: 'posix' as const
    }))
    const { input, root } = await render()
    browseDir.mockClear()
    browseDir.mockImplementationOnce(() => new Promise(() => {}))

    await press(input, 'Enter')
    await press(input, 'Enter')

    expect(browseDir).toHaveBeenCalledTimes(1)
    await act(async () => root.unmount())
  })

  // Why: the cached home listing comes back as the same array under `~/`, which must not keep the moved row.
  it('commits a typed path instead of a row highlighted before typing it', async () => {
    vi.useFakeTimers()
    const { input, root } = await render()
    await press(input, 'ArrowDown')
    browseDir.mockClear()

    await type(input, '~/')
    await settlePathResolve()
    await press(input, 'Enter')

    // Committing `~/` reopens the cached home listing and clears the typed path.
    expect(input.value).toBe('')
    expect(browseDir).not.toHaveBeenCalledWith({
      targetId: 'target-1',
      dirPath: '/home/alice/src'
    })
    await act(async () => root.unmount())
  })

  // Why: until the debounce resolves `docs/`, the preview and its moved highlight still show `~/`.
  it('ignores Enter on a typed directory that has not resolved yet', async () => {
    vi.useFakeTimers()
    const { input, root } = await render()
    await type(input, '~/')
    await settlePathResolve()
    await press(input, 'ArrowDown')
    await press(input, 'ArrowDown')
    browseDir.mockClear()

    await type(input, '~/docs/')
    await press(input, 'Enter')
    expect(browseDir).not.toHaveBeenCalled()

    await settlePathResolve()
    await press(input, 'Enter')
    expect(browseDir).toHaveBeenLastCalledWith({
      targetId: 'target-1',
      dirPath: '/home/alice/docs'
    })
    await act(async () => root.unmount())
  })

  // Why: before the first preview, `.` still filters the old rows, so the default highlight is a dotfolder.
  it('ignores Enter on path input that has no preview yet', async () => {
    vi.useFakeTimers()
    browseDir.mockImplementationOnce(async () => ({
      entries: [
        { name: '.config', isDirectory: true },
        { name: '.ssh', isDirectory: true }
      ],
      resolvedPath: '/home/alice',
      pathFlavor: 'posix' as const
    }))
    const { input, root } = await render()
    browseDir.mockClear()

    await type(input, '.')
    await press(input, 'Enter')

    expect(browseDir).not.toHaveBeenCalled()
    await act(async () => root.unmount())
  })
})
