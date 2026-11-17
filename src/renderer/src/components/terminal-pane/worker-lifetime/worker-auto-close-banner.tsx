import { Timer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { workerKeepOpenLabel } from '@/runtime/agent-orchestration/worker-auto-close'
import type { Translate } from '@/i18n/use-translate'
import {
  formatWorkerAutoCloseCountdown,
  type WorkerAutoCloseState
} from '../../../../../shared/orchestration/workers/worker-auto-close'
import type { PaneTopBannerProps } from '../appearance/pane-top-banner/PaneTopWarningBanner'

/** A temporary orchestration worker's banner, the same in a terminal and a chat; null once kept open. */
export function workerAutoCloseBannerProps(
  state: WorkerAutoCloseState | null,
  nowMs: number,
  keepOpen: () => void,
  t: Translate
): PaneTopBannerProps | null {
  if (!state || state.kept) {
    return null
  }
  const title =
    state.closesAt === null
      ? t(
          'components.orchestration.workerAutoClose.bannerRunning',
          'Orchestration worker · Closes 2 minutes after it finishes'
        )
      : t(
          'components.orchestration.workerAutoClose.bannerFinished',
          'Orchestration worker finished · Closes in {{countdown}}',
          { countdown: formatWorkerAutoCloseCountdown(state.closesAt, nowMs) }
        )
  return {
    tone: state.closesAt === null ? 'accent' : 'warning',
    icon: Timer,
    badge: t('components.orchestration.workerAutoClose.temporaryBadge', 'Temporary'),
    title,
    primaryAction: (
      <Button type="button" variant="default" size="xs" onClick={keepOpen}>
        {workerKeepOpenLabel(t)}
      </Button>
    )
  }
}
