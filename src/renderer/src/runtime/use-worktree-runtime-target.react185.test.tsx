/** @vitest-environment happy-dom */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/store', async () => {
  const { create } = await import('zustand')
  return { useAppStore: create(() => ({})) }
})

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => 'local'
}))

import { useWorktreeRuntimeTarget } from './use-worktree-runtime-target'

const mounted: { container: HTMLDivElement; root: ReturnType<typeof createRoot> }[] = []

afterEach(() => {
  for (const { container, root } of mounted) {
    act(() => root.unmount())
    container.remove()
  }
  mounted.length = 0
})

function TargetProbe(): React.JSX.Element {
  const target = useWorktreeRuntimeTarget(null)
  return <span>{target?.kind}</span>
}

class CaptureBoundary extends React.Component<
  { children: React.ReactNode; errors: Error[] },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: Error): void {
    this.props.errors.push(error)
  }

  render(): React.ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

describe('useWorktreeRuntimeTarget React snapshot identity', () => {
  it('mounts without a maximum-update-depth loop when the owner is unchanged', () => {
    const errors: Error[] = []
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container, { onCaughtError: () => undefined })
    mounted.push({ container, root })

    act(() => {
      root.render(
        <CaptureBoundary errors={errors}>
          <TargetProbe />
        </CaptureBoundary>
      )
    })

    expect(errors).toEqual([])
    expect(container.textContent).toBe('local')
  })
})
