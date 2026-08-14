/** @vitest-environment happy-dom */
import { StrictMode, act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { disposeParkedTabWatchers, parkedWatchersByTabId } from './terminal-parked-watcher-registry'
import { useTerminalParkMountIntent } from './use-terminal-park-mount-intent'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TAB_ID = 'strict-park-reveal'
const observations: boolean[] = []

function Child(): null {
  const mountFollowsTerminalPark = useTerminalParkMountIntent(TAB_ID)
  useEffect(() => {
    observations.push(mountFollowsTerminalPark)
  }, [mountFollowsTerminalPark])
  return null
}

function Parent() {
  useEffect(() => {
    disposeParkedTabWatchers(TAB_ID)
  }, [])
  return <Child />
}

function parkTab(): void {
  parkedWatchersByTabId.set(TAB_ID, {
    worktreeId: 'wt-1',
    tabPtyId: 'pty-1',
    paneIdByPtyId: new Map([['pty-1', 1]]),
    disposersByPtyId: new Map([['pty-1', () => {}]])
  })
}

afterEach(() => {
  observations.length = 0
  disposeParkedTabWatchers(TAB_ID)
})

describe('useTerminalParkMountIntent', () => {
  it('survives StrictMode effect replay after the parent disposes the watcher', () => {
    parkTab()
    const container = document.createElement('div')
    const root = createRoot(container)

    act(() => {
      root.render(
        <StrictMode>
          <Parent />
        </StrictMode>
      )
    })

    expect(observations).toEqual([true, true])
    act(() => root.unmount())
  })

  // Why: the lifecycle effect re-runs on cwd changes for the same component
  // instance, so intent cached per instance would resupply a stale park reveal.
  it('re-reads park intent when the same instance re-renders after disposal', () => {
    parkTab()
    const container = document.createElement('div')
    const root = createRoot(container)

    act(() => root.render(<Child />))
    expect(observations).toEqual([true])

    disposeParkedTabWatchers(TAB_ID)
    act(() => root.render(<Child />))

    expect(observations).toEqual([true, false])
    act(() => root.unmount())
  })
})
