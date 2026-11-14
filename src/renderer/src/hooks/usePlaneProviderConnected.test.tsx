// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { PlaneConnectionStatus } from '../../../shared/plane-types'
import { useAppStore } from '@/store'
import { usePlaneProviderConnected } from './usePlaneProviderConnected'

let root: Root | null = null
let container: HTMLDivElement | null = null

describe('usePlaneProviderConnected', () => {
  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    root = null
    container?.remove()
    container = null
    useAppStore.setState({
      planeStatus: {
        connected: false,
        viewer: null,
        instanceUrl: 'https://api.plane.so',
        authType: 'cloud',
        workspaces: [],
        activeWorkspaceSlug: null,
        selectedWorkspaceSlug: null
      }
    })
  })

  it('does not rerender for Plane metadata changes that preserve connected state', () => {
    useAppStore.setState({
      planeStatus: {
        connected: true,
        viewer: { id: 'u1', email: 'user@example.com', username: 'user', displayName: 'User' },
        instanceUrl: 'https://api.plane.so',
        authType: 'cloud',
        workspaces: [],
        activeWorkspaceSlug: 'ws-1',
        selectedWorkspaceSlug: 'ws-1'
      }
    })
    let renders = 0
    let connected = false

    function Probe(): null {
      renders += 1
      connected = usePlaneProviderConnected()
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
        planeStatus: {
          ...useAppStore.getState().planeStatus,
          selectedWorkspaceSlug: 'ws-2'
        } satisfies PlaneConnectionStatus
      })
    })

    expect(connected).toBe(true)
    expect(renders).toBe(1)

    act(() => {
      useAppStore.setState({
        planeStatus: {
          ...useAppStore.getState().planeStatus,
          connected: false
        }
      })
    })

    expect(connected).toBe(false)
    expect(renders).toBe(2)
  })
})
