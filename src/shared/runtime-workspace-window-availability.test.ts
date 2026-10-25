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
    // Headless serve owns a ready graph without a window; window absence must not degrade it (#6844).
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
    // openable also means no live renderer; treat mid-reload teardown like unavailable.
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
