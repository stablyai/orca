import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildReactErrorBoundaryReportArgs,
  clearReactErrorBoundaryReportingForTest,
  reportReactErrorBoundaryCrash
} from './react-error-boundary-reporting'
import type { CrashReportRecord } from '../../../shared/crash-reporting'

const mocks = vi.hoisted(() => ({
  recordRendererError: vi.fn(),
  dispatchEvent: vi.fn(),
  state: {
    activeView: 'terminal',
    activeModal: 'none',
    activeTabType: 'editor',
    rightSidebarTab: 'source-control',
    activeWorktreeId: 'repo-1::/Users/alice/project'
  }
}))

function makeReport(id: string): CrashReportRecord {
  return {
    id,
    createdAt: '2026-05-30T20:00:00.000Z',
    status: 'pending',
    source: 'renderer',
    processType: 'react-render',
    reason: 'react-error-boundary',
    exitCode: null,
    appVersion: '1.0.0',
    platform: 'darwin',
    osRelease: '25.0.0',
    arch: 'arm64',
    electronVersion: '41.0.0',
    chromeVersion: '141.0.0',
    details: { surface: 'page' }
  }
}

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.state
  }
}))

beforeEach(() => {
  clearReactErrorBoundaryReportingForTest()
  mocks.recordRendererError.mockReset()
  mocks.dispatchEvent.mockReset()
  mocks.recordRendererError.mockResolvedValue({
    ok: true,
    report: makeReport('react-report-1'),
    deduped: false
  })
  vi.stubGlobal('window', {
    dispatchEvent: mocks.dispatchEvent,
    api: {
      crashReports: {
        recordRendererError: mocks.recordRendererError
      }
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('react error boundary reporting', () => {
  it('builds a renderer error payload with low-cardinality app context', () => {
    const args = buildReactErrorBoundaryReportArgs({
      boundaryId: 'terminal.workbench',
      surface: 'terminal-workbench',
      error: new TypeError('Cannot render /Users/alice/project'),
      errorInfo: { componentStack: 'at Terminal\nat App' },
      context: {
        activeView: 'terminal',
        activeModal: 'none',
        activeTabType: 'editor',
        activeRightSidebarTab: 'source-control',
        hasActiveWorktree: true
      }
    })

    expect(args).toMatchObject({
      boundaryId: 'terminal.workbench',
      surface: 'terminal-workbench',
      errorName: 'TypeError',
      errorMessage: 'Cannot render /Users/alice/project',
      componentStack: 'at Terminal\nat App',
      activeView: 'terminal',
      activeModal: 'none',
      activeTabType: 'editor',
      activeRightSidebarTab: 'source-control',
      hasActiveWorktree: true
    })
  })

  it('reports a caught render error once per boundary signature', async () => {
    const error = new Error('render failed')
    await reportReactErrorBoundaryCrash({
      boundaryId: 'page.settings',
      surface: 'page',
      error,
      errorInfo: { componentStack: 'at Settings\nat App' }
    })
    await reportReactErrorBoundaryCrash({
      boundaryId: 'page.settings',
      surface: 'page',
      error,
      errorInfo: { componentStack: 'at Settings\nat App' }
    })

    expect(mocks.recordRendererError).toHaveBeenCalledTimes(1)
    expect(mocks.dispatchEvent).toHaveBeenCalledTimes(1)
    expect(mocks.recordRendererError).toHaveBeenCalledWith(
      expect.objectContaining({
        boundaryId: 'page.settings',
        surface: 'page',
        activeView: 'terminal',
        activeModal: 'none',
        activeTabType: 'editor',
        activeRightSidebarTab: 'source-control',
        hasActiveWorktree: true
      })
    )
  })
})
