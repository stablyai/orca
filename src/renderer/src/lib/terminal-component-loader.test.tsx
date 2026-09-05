// @vitest-environment happy-dom
import { act, Suspense, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { expect, it, vi } from 'vitest'
import { loadTerminalComponent, PreloadedTerminal } from './terminal-component-loader'

const lifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }))

vi.mock('../components/Terminal', () => ({
  default: function TestTerminal() {
    useEffect(() => {
      lifecycle.mounts++
      return () => {
        lifecycle.unmounts++
      }
    }, [])
    return <input aria-label="terminal input" defaultValue="draft" />
  }
}))

it('keeps a cold terminal mounted and renders a preloaded terminal without suspending', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div')
  const root = createRoot(host)
  const surface = () => (
    <Suspense fallback={<span>Loading terminal</span>}>
      <PreloadedTerminal />
    </Suspense>
  )
  try {
    await act(async () => {
      flushSync(() => root.render(surface()))
      expect(host.textContent).toContain('Loading terminal')
      await vi.dynamicImportSettled()
    })
    const input = host.querySelector('input')!
    expect(input).not.toBeNull()
    input.value = 'unsent input'

    await act(async () => root.render(surface()))
    expect(host.querySelector('input')).toBe(input)
    expect(input.value).toBe('unsent input')
    expect(lifecycle.mounts).toBe(1)
    expect(lifecycle.unmounts).toBe(0)

    await act(async () => root.render(null))
    await loadTerminalComponent()
    // A ready module must paint in this commit, without a Suspense retry.
    flushSync(() => root.render(surface()))
    expect(host.querySelector('input')).not.toBeNull()
    expect(host.textContent).not.toContain('Loading terminal')
  } finally {
    await act(async () => root.unmount())
    vi.unstubAllGlobals()
  }
})
