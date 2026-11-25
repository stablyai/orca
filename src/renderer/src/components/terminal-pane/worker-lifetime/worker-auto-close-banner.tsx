import { Button } from '@/components/ui/button'
import { workerKeepOpenLabel } from '@/runtime/agent-orchestration/worker-auto-close'
import type { Translate } from '@/i18n/use-translate'
import {
  formatWorkerAutoCloseCountdown,
  WORKER_AUTO_CLOSE_GRACE_MS,
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
      'Closes {{minutes}} min after finishing',
      { minutes: Math.round(WORKER_AUTO_CLOSE_GRACE_MS / 60_000) }
    )
  ) : (
    t(
      'components.orchestration.workerAutoClose.bannerFinished',
      'Finished · closes in {{countdown}}',
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
            'Worker finished · closes soon'
          ),
    tone: 'quiet',
    title,
    progress:
      state.closesAt === null
        ? undefined
        : (Date.parse(state.closesAt) - nowMs) / WORKER_AUTO_CLOSE_GRACE_MS,
    primaryAction: (
      <Button type="button" variant="ghost-muted" size="xs-compact" onClick={keepOpen}>
        {workerKeepOpenLabel(t)}
      </Button>
    )
  }
}
