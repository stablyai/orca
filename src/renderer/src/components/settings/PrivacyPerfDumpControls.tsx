import { Activity, Loader2 } from 'lucide-react'
import type {
  DiagnosticsStatusPayload,
  PerfDumpProgressPayload
} from '../../../../preload/api-types'
import { Button } from '../ui/button'
import { translate } from '@/i18n/i18n'

type PerfDumpStage = PerfDumpProgressPayload['stage'] | null

export function PrivacyPerfDumpControls({
  status,
  capturing,
  onCapture
}: {
  readonly status: DiagnosticsStatusPayload | null
  readonly capturing: boolean
  readonly onCapture: () => Promise<void>
}): React.JSX.Element {
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={!status?.perfDumpEnabled || capturing}
      title={
        status && !status.perfDumpEnabled
          ? translate(
              'auto.components.settings.PrivacyPerfDumpControls.7c31a80d92',
              'Performance reports are disabled.'
            )
          : undefined
      }
      onClick={() => void onCapture()}
    >
      {capturing ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <Activity className="size-3.5" />
      )}
      {translate(
        'auto.components.settings.PrivacyPerfDumpControls.4b6e08d217',
        'Capture performance report'
      )}
    </Button>
  )
}

export function getPerfDumpDescription(stage: PerfDumpStage): string {
  if (stage === 'metrics') {
    return translate(
      'auto.components.settings.PrivacyPerfDumpControls.2a90ef73c4',
      'Collecting app metrics…'
    )
  }
  if (stage === 'profile') {
    return translate(
      'auto.components.settings.PrivacyPerfDumpControls.8de51c30b5',
      'Profiling CPU activity (10s)…'
    )
  }
  if (stage === 'compressing') {
    return translate('auto.components.settings.PrivacyPerfDumpControls.05d8e75876', 'Compressing…')
  }
  return translate(
    'auto.components.settings.PrivacyPerfDumpControls.6dc19f4ab3',
    'Records about 10 seconds of CPU activity from the interface and background process, plus app metrics. Contains Orca function names and workspace folder names — no terminal text; saved to your computer only, nothing is uploaded.'
  )
}
