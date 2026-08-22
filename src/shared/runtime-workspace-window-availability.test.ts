import { describe, expect, it } from 'vitest'
import type { RuntimeStatus } from './runtime-types'
import { isRuntimeWorkspaceWindowClosed } from './runtime-workspace-window-availability'

function makeStatus(overrides: Partial<RuntimeStatus>): RuntimeStatus {
  return {
    runtimeId: 'runtime-hub',
    rendererGraphEpoch: 1,
    graphStatus: 'ready',
    authoritativeWindowId: 1,
    liveTabCount: 0,
    liveLeafCount: 0,
    ...overrides
  }
}

describe('isRuntimeWorkspaceWindowClosed', () => {
  it('flags a reachable host whose graph is gone but whose desktop window can be opened', () => {
    expect(
      isRuntimeWorkspaceWindowClosed(
        makeStatus({
          graphStatus: 'unavailable',
          authoritativeWindowId: null,
          desktopWindowStatus: 'openable'
        })
      )
    ).toBe(true)
  })

  it('leaves graph-ready headless servers alone', () => {
    // Why: #6844 headless serve owns a graph without a desktop window — it must
    // never read as degraded just because a window could be opened.
    expect(
      isRuntimeWorkspaceWindowClosed(
        makeStatus({ graphStatus: 'ready', desktopWindowStatus: 'openable' })
      )
    ).toBe(false)
  })

  it('ignores a renderer reload that still owns its window', () => {
    expect(
      isRuntimeWorkspaceWindowClosed(
        makeStatus({ graphStatus: 'reloading', desktopWindowStatus: 'available' })
      )
    ).toBe(false)
  })

  it('flags a reload whose window disappeared before the graph was marked unavailable', () => {
    // Why: 'openable' already means no live renderer window, so a mid-reload window
    // teardown is just as unusable as 'unavailable'.
    expect(
      isRuntimeWorkspaceWindowClosed(
        makeStatus({ graphStatus: 'reloading', desktopWindowStatus: 'openable' })
      )
    ).toBe(true)
  })

  it('treats a missing desktop window claim as no claim', () => {
    expect(isRuntimeWorkspaceWindowClosed(makeStatus({ graphStatus: 'unavailable' }))).toBe(false)
    expect(
      isRuntimeWorkspaceWindowClosed(
        makeStatus({ graphStatus: 'unavailable', desktopWindowStatus: 'initializing' })
      )
    ).toBe(false)
    expect(
      isRuntimeWorkspaceWindowClosed(
        makeStatus({ graphStatus: 'unavailable', desktopWindowStatus: 'blocked' })
      )
    ).toBe(false)
  })

  it('is not a substitute for an unreachable host', () => {
    expect(isRuntimeWorkspaceWindowClosed(null)).toBe(false)
    expect(isRuntimeWorkspaceWindowClosed(undefined)).toBe(false)
  })
})
