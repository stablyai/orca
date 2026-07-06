import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { recordRendererCrashBreadcrumbMock } = vi.hoisted(() => ({
  recordRendererCrashBreadcrumbMock: vi.fn()
}))

vi.mock('../../lib/crash-diagnostics', () => ({
  recordRendererCrashBreadcrumb: recordRendererCrashBreadcrumbMock
}))

describe('warnTerminalLifecycleAnomaly', () => {
  beforeEach(() => {
    vi.resetModules()
    recordRendererCrashBreadcrumbMock.mockClear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('records a compact crash breadcrumb without raw worktree or pty ids', async () => {
    const { warnTerminalLifecycleAnomaly } = await import('./terminal-lifecycle-diagnostics')

    warnTerminalLifecycleAnomaly('missing-pane', {
      tabId: 'tab-1',
      worktreeId: 'repo::C:\\secret\\workspace',
      leafId: 'leaf-1',
      paneId: 2,
      ptyId: 'pty-secret',
      reason: 'detached-layout'
    })

    expect(recordRendererCrashBreadcrumbMock).toHaveBeenCalledWith('terminal_lifecycle_anomaly', {
      event: 'missing-pane',
      tabId: 'tab-1',
      leafId: 'leaf-1',
      paneId: 2,
      reason: 'detached-layout',
      hasWorktreeId: true,
      hasPtyId: true
    })
  })
})
