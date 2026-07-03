// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteFileBrowser } from './RemoteFileBrowser'

type BrowseDirArgs = {
  dirPath: string
  targetId: string
}

const browseDir = vi.fn(async ({ dirPath }: BrowseDirArgs) => ({
  entries: [
    { name: 'src', isDirectory: true },
    { name: 'README.md', isDirectory: false }
  ],
  resolvedPath: dirPath === '~' ? '/home/alice' : dirPath
}))

async function flushPromises(count = 4): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve()
  }
}

async function renderRemoteFileBrowser(): Promise<{
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

async function changeInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    valueSetter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function advancePathResolveDebounce(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(300)
    await flushPromises()
  })
}

describe('RemoteFileBrowser paste-sized input', () => {
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    browseDir.mockClear()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ssh: {
          browseDir
        }
      }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  it('still debounces and resolves ordinary path-mode input', async () => {
    const { input, root } = await renderRemoteFileBrowser()
    browseDir.mockClear()

    await changeInput(input, 'src/')
    expect(browseDir).not.toHaveBeenCalled()

    await advancePathResolveDebounce()

    expect(browseDir).toHaveBeenCalledWith({ targetId: 'target-1', dirPath: '/home/alice/src' })

    await act(async () => {
      root.unmount()
    })
  })

  it('does not parse or remotely resolve oversized slash-containing paste text', async () => {
    const { container, input, root } = await renderRemoteFileBrowser()
    const pastedSecretPathList = 'C:/Users/alice/project/secret-token-value.txt\n'.repeat(2_000)
    browseDir.mockClear()

    await changeInput(input, pastedSecretPathList)
    await advancePathResolveDebounce()

    expect(browseDir).not.toHaveBeenCalled()
    expect(container.textContent).toContain('No matches for this long input')
    expect(container.textContent).not.toContain('secret-token-value')

    await act(async () => {
      root.unmount()
    })
  })
})
