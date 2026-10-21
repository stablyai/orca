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

async function press(input: HTMLInputElement, key: string): Promise<void> {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
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
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  it('highlights the first row and moves it with the arrow keys', async () => {
    const { container, input, root } = await render()
    expect(selectedRow(container)).toBe('docs')
    expect(input.getAttribute('aria-activedescendant')).toBe(
      container.querySelector('[role="option"][aria-selected="true"]')?.id
    )

    await press(input, 'ArrowDown')
    await press(input, 'ArrowDown')
    await press(input, 'ArrowDown')
    expect(selectedRow(container)).toBe('README.md')

    await press(input, 'ArrowUp')
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
})
