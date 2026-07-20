// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { LinearConnectionStatus } from '../../../shared/types'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { useAppStore } from '@/store'
import { useLinearProviderConnected } from './useLinearProviderConnected'

let root: Root | null = null
let container: HTMLDivElement | null = null

describe('useLinearProviderConnected', () => {
  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    root = null
    container?.remove()
    container = null
    useAppStore.setState({
      linearStatus: { connected: false, viewer: null },
      linearStatusContextKey: null
    })
  })

  it('does not rerender for Linear metadata changes that preserve section visibility', () => {
    const settings = useAppStore.getState().settings
    useAppStore.setState({
      linearStatus: { connected: true, viewer: null },
      linearStatusContextKey: getProviderRuntimeContextKey(settings)
    })
    let renders = 0
    let connected = false

    function Probe(): null {
      renders += 1
      connected = useLinearProviderConnected()
      return null
    }

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root?.render(<Probe />))

    expect(connected).toBe(true)
    expect(renders).toBe(1)

    act(() => {
      useAppStore.setState({
        linearStatus: {
          ...useAppStore.getState().linearStatus,
          selectedWorkspaceId: 'workspace-2'
        } satisfies LinearConnectionStatus
      })
    })

    expect(connected).toBe(true)
    expect(renders).toBe(1)

    act(() => {
      useAppStore.setState({ linearStatus: { connected: false, viewer: null } })
    })

    expect(connected).toBe(false)
    expect(renders).toBe(2)
  })

  it('rejects a connected status from a different runtime context', () => {
    useAppStore.setState({
      linearStatus: { connected: true, viewer: null },
      linearStatusContextKey: 'stale-runtime-context'
    })
    let connected = true

    function Probe(): null {
      connected = useLinearProviderConnected()
      return null
    }

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root?.render(<Probe />))

    expect(connected).toBe(false)
  })
})
