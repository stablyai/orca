// @vitest-environment happy-dom

import { act, startTransition, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { useWorkspaceDefaultAgent } from './use-workspace-default-agent'

it('keeps the visible target writable while another target render is suspended', () => {
  const pending = new Promise<void>(() => {})
  function Target({ repo, suspend = false }: { repo: string; suspend?: boolean }) {
    const { hostDefaultAgent, recordAgent } = useWorkspaceDefaultAgent(repo, 'local', false)
    if (suspend) {
      throw pending
    }
    return <button onClick={() => recordAgent('codex')}>{hostDefaultAgent ?? 'automatic'}</button>
  }
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    act(() =>
      root.render(
        <Suspense fallback="loading">
          <Target repo="visible" />
        </Suspense>
      )
    )
    act(() => {
      startTransition(() =>
        root.render(
          <Suspense fallback="loading">
            <Target repo="pending" suspend />
          </Suspense>
        )
      )
    })
    const button = container.querySelector('button')
    if (!button) {
      throw new Error('Visible workspace target was replaced before the transition committed')
    }
    act(() => button.click())
    expect(container.textContent).toBe('codex')
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})
