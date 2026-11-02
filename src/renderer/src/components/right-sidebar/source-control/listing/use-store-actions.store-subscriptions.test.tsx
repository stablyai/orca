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
  it('keeps only the two generation-record maps subscribed', () => {
    const baseline = listenerCount()

    function Probe(): null {
      useSourceControlStoreActions()
      return null
    }
    mount(<Probe />)

    // Subscribe only to the two generation maps; fixed-identity actions come from getState().
    expect(listenerCount() - baseline).toBe(2)

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

  it('still tracks the generation-record maps it subscribes to', () => {
    let latest: SourceControlStoreActions | null = null
    function Probe(): null {
      latest = useSourceControlStoreActions()
      return null
    }
    function read(): SourceControlStoreActions {
      if (!latest) {
        throw new Error('probe did not render')
      }
      return latest
    }
    mount(<Probe />)

    const before = read()
    const record = { status: 'pending' } as never
    act(() => {
      useAppStore.setState({
        pullRequestGenerationRecords: { 'wt-1': record }
      })
    })

    expect(read()).not.toBe(before)
    expect(read().prGenerationRecords).toEqual({ 'wt-1': record })

    const afterPr = read()
    act(() => {
      useAppStore.setState({
        commitMessageGenerationRecords: { 'wt-1': record }
      })
    })
    expect(read()).not.toBe(afterPr)
    expect(read().commitMessageGenerationRecords).toEqual({ 'wt-1': record })
  })
})
