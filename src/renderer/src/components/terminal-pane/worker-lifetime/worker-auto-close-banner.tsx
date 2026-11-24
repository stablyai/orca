import { Timer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { workerKeepOpenLabel } from '@/runtime/agent-orchestration/worker-auto-close'
import type { Translate } from '@/i18n/use-translate'
import {
  formatWorkerAutoCloseCountdown,
  type WorkerAutoCloseState
} from '../../../../../shared/orchestration/workers/worker-auto-close'
import type { PaneTopBannerProps } from '../appearance/pane-top-banner/PaneTopWarningBanner'
import { BoundWorkerTitle } from './BoundWorkerTitle'

/** A temporary orchestration worker's banner, the same in a terminal and a chat; null once kept open. */
export function workerAutoCloseBannerProps(
  state: WorkerAutoCloseState | null,
  nowMs: number,
  keepOpen: () => void,
  t: Translate,
  environmentId: string | null = null
): PaneTopBannerProps | null {
  if (!state || state.kept) {
    return null
  }
  const countdown =
    state.closesAt === null ? null : formatWorkerAutoCloseCountdown(state.closesAt, nowMs)
  const title = state.boundTo ? (
    <BoundWorkerTitle boundTo={state.boundTo} countdown={countdown} environmentId={environmentId} />
  ) : countdown === null ? (
    t(
      'components.orchestration.workerAutoClose.bannerRunning',
      'Orchestration worker · Closes 2 minutes after it finishes'
    )
  ) : (
    t(
      'components.orchestration.workerAutoClose.bannerFinished',
      'Orchestration worker finished · Closes in {{countdown}}',
      { countdown }
    )
  )
  return {
    // Why empty while running: one live node that mounts empty is announced reliably when finishing
    // fills it; a pre-filled or re-mounted region may be skipped. The ticking countdown stays outside it.
    announcement:
      state.closesAt === null
        ? ''
        : t(
            'components.orchestration.workerAutoClose.bannerFinishedStatus',
            'Orchestration worker finished · Closes soon'
          ),
    tone: state.closesAt === null ? 'accent' : 'warning',
    icon: Timer,
    title,
    primaryAction: (
      <Button type="button" variant="default" size="xs" onClick={keepOpen}>
        {workerKeepOpenLabel(t)}
      </Button>
    )
  }
}
