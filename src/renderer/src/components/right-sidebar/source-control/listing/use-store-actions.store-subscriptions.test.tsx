// @vitest-environment happy-dom

import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { readStoreListenerCount } from '@/store/store-listener-census'
import { useSourceControlStoreActions, type SourceControlStoreActions } from './use-store-actions'

const originalState = useAppStore.getState()

let root: Root | null = null
let container: HTMLDivElement | null = null

function mount(node: ReactNode): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root?.render(node))
}

function unmount(): void {
  if (root) {
    act(() => root?.unmount())
  }
  root = null
  container?.remove()
  container = null
}

function listenerCount(): number {
  const count = readStoreListenerCount()
  if (count === null) {
    throw new Error('store listener census unavailable')
  }
  return count
}

afterEach(() => {
  unmount()
  useAppStore.setState(originalState, true)
})

describe('useSourceControlStoreActions store subscriptions', () => {
  it('subscribes to no store slices', () => {
    const baseline = listenerCount()

    function Probe(): null {
      useSourceControlStoreActions()
      return null
    }
    mount(<Probe />)

    // Fixed-identity actions come from getState(); generation records are selected per owner by their consumers.
    expect(listenerCount() - baseline).toBe(0)

    unmount()
    expect(listenerCount()).toBe(baseline)
  })

  it('returns the same object across an unrelated store write and re-render', () => {
    let latest: SourceControlStoreActions | null = null
    let rerender: (() => void) | null = null

    function Probe(): null {
      const [, setTick] = useState(0)
      rerender = () => setTick((t) => t + 1)
      latest = useSourceControlStoreActions()
      return null
    }
    mount(<Probe />)

    const first = latest
    expect(first).not.toBeNull()

    act(() => {
      useAppStore.setState({
        rightSidebarOpen: !originalState.rightSidebarOpen
      })
    })
    act(() => rerender?.())

    expect(latest).toBe(first)
  })
})
