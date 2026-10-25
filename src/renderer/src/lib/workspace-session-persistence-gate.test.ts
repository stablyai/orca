import { describe, expect, it } from 'vitest'
import { shouldPersistWorkspaceSession } from './workspace-session'

describe('shouldPersistWorkspaceSession', () => {
  it('returns false before either flag is set', () => {
    expect(
      shouldPersistWorkspaceSession({
        workspaceSessionReady: false,
        hydrationSucceeded: false
      })
    ).toBe(false)
  })

  it('returns false when the UI is ready but hydration failed', () => {
    // Error UI may mount, but persistence must remain closed or empty memory overwrites disk.
    expect(
      shouldPersistWorkspaceSession({
        workspaceSessionReady: true,
        hydrationSucceeded: false
      })
    ).toBe(false)
  })

  it('returns false when hydration finished but UI is not ready yet', () => {
    expect(
      shouldPersistWorkspaceSession({
        workspaceSessionReady: false,
        hydrationSucceeded: true
      })
    ).toBe(false)
  })

  it('returns true only when both flags are set', () => {
    expect(
      shouldPersistWorkspaceSession({
        workspaceSessionReady: true,
        hydrationSucceeded: true
      })
    ).toBe(true)
  })
})
