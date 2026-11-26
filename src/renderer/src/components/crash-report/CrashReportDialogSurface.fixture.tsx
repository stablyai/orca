import { defineFixture } from '../../component-fixtures/component-fixture'
import type { CrashReportRecord } from '../../../../shared/crash-reporting/crash-reporting'
import { CrashReportDialogSurface } from './CrashReportDialogSurface'

const base: CrashReportRecord = {
  id: 'crash-report-1',
  createdAt: '2026-11-12T01:00:00.000Z',
  status: 'pending',
  source: 'child',
  processType: 'renderer',
  reason: 'crashed',
  exitCode: 5,
  appVersion: '1.4.214',
  platform: 'darwin',
  osRelease: '25.1.0',
  arch: 'arm64',
  electronVersion: '43',
  chromeVersion: '150',
  details: { surface: 'workspace terminal' }
}

function dialogFixture(report: CrashReportRecord) {
  return defineFixture({
    width: 640,
    setup: () => {
      Object.assign(window.api.gh, { viewer: () => Promise.resolve(null) })
    },
    render: () => (
      <div className="h-[520px] bg-background">
        <CrashReportDialogSurface
          open
          report={report}
          loading={false}
          onOpenChange={() => {}}
          onReportChange={() => {}}
        />
      </div>
    )
  })
}

export const crash = dialogFixture(base)

export const freeze = dialogFixture({
  ...base,
  id: 'freeze-report-1',
  processType: 'main',
  reason: 'main-thread-hang',
  exitCode: null,
  details: { captureId: 'incident-1', detectedAt: '2026-11-11T23:00:00.000Z' }
})
