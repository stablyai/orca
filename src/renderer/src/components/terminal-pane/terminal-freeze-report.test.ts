// Why: pins the one-paste freeze report contract — a single console call must
// return renderer state + main snapshot + breadcrumbs, and a dead/throwing
// invoke channel must be captured as data instead of sinking the report.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/e2e-config', () => ({ e2eConfig: { exposeStore: false } }))

describe('terminal freeze report', () => {
  const originalWindow = (globalThis as { window?: unknown }).window
  const originalDocument = (globalThis as { document?: unknown }).document
  const snapshotMock = vi.fn()
  const listenerCountMock = vi.fn(() => 1)

  beforeEach(() => {
    vi.resetModules()
    snapshotMock.mockReset()
    listenerCountMock.mockClear()
    ;(globalThis as { document: unknown }).document = {
      visibilityState: 'hidden',
      hasFocus: () => true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }
    ;(globalThis as { window: unknown }).window = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      api: {
        pty: {
          getRendererDeliveryDebugSnapshot: snapshotMock,
          getPtyDataListenerCount: listenerCountMock
        }
      }
    }
  })

  afterEach(() => {
    ;(globalThis as { window: unknown }).window = originalWindow
    ;(globalThis as { document: unknown }).document = originalDocument
  })

  it('assembles renderer state, breadcrumbs, and the main snapshot into one blob', async () => {
    snapshotMock.mockResolvedValue({ pendingPtyCount: 0, diagnostics: { perPty: [] } })
    const breadcrumbs = await import('./terminal-freeze-breadcrumbs')
    breadcrumbs.recordTerminalFreezeBreadcrumb('gate-mark', { id: '…@@abc' })
    const { buildTerminalFreezeReport } = await import('./terminal-freeze-report')

    const report = await buildTerminalFreezeReport()

    expect(report.renderer.documentVisibilityState).toBe('hidden')
    expect(report.renderer.documentHasFocus).toBe(true)
    expect(report.renderer.ptyDataListenerCount).toBe(1)
    expect(report.renderer.breadcrumbs.map((crumb) => crumb.kind)).toContain('gate-mark')
    expect(report.renderer.watchdog).toMatchObject({ running: false, healCount: 0 })
    expect(report.main).toMatchObject({ pendingPtyCount: 0 })
    expect(typeof report.capturedAt).toBe('string')
  })

  it('captures a failing invoke channel as data instead of throwing', async () => {
    snapshotMock.mockRejectedValue(new Error('invoke dead'))
    const { buildTerminalFreezeReport } = await import('./terminal-freeze-report')

    const report = await buildTerminalFreezeReport()

    expect(report.main).toMatchObject({ snapshotError: expect.stringContaining('invoke dead') })
  })

  it('installs the console-callable global exactly once per renderer', async () => {
    snapshotMock.mockResolvedValue({ pendingPtyCount: 0 })
    const { installTerminalFreezeReport, buildTerminalFreezeReport } =
      await import('./terminal-freeze-report')
    installTerminalFreezeReport()
    const installed = (
      globalThis.window as unknown as {
        __orcaTerminalFreezeReport?: () => Promise<unknown>
      }
    ).__orcaTerminalFreezeReport
    expect(installed).toBe(buildTerminalFreezeReport)
  })
})
