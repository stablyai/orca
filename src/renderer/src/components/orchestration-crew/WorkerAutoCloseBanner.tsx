import { useMemo } from 'react'
import { Timer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store/index'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { useWorkerAutoClose, workerKeepOpenLabel } from '@/lib/worker-auto-close'
import { translate } from '@/i18n/i18n'
import { formatWorkerAutoCloseCountdown } from '../../../../shared/worker-auto-close'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { PaneTopWarningBanner } from '../terminal-pane/appearance/pane-top-banner/PaneTopWarningBanner'

/** Across a temporary orchestration worker's pane: when it closes, and Keep open. */
export function WorkerAutoCloseBanner({
  tabId,
  leafId,
  worktreeId,
  isVisible
}: {
  tabId: string
  leafId: string
  worktreeId: string
  isVisible: boolean
}): React.JSX.Element | null {
  const environmentId = useAppStore((state) =>
    runtimeEnvironmentIdOrLocalUnlessTwin(state, worktreeId)
  )
  const target = useMemo(
    () =>
      environmentId !== null
        ? { kind: 'environment' as const, environmentId }
        : { kind: 'local' as const },
    [environmentId]
  )
  const paneKey = makePaneKey(tabId, leafId)
  const subject = useMemo(() => ({ paneKey }), [paneKey])
  const { state, nowMs, keepOpen } = useWorkerAutoClose(target, subject, paneKey, isVisible)
  if (!state || state.kept) {
    return null
  }
  const title =
    state.closesAt === null
      ? translate(
          'components.orchestration.workerAutoClose.bannerRunning',
          'Orchestration worker · Closes 2 minutes after it finishes'
        )
      : translate(
          'components.orchestration.workerAutoClose.bannerFinished',
          'Orchestration worker finished · Closes in {{countdown}}',
          { countdown: formatWorkerAutoCloseCountdown(state.closesAt, nowMs) }
        )
  return (
    <PaneTopWarningBanner
      tone={state.closesAt === null ? 'accent' : 'warning'}
      icon={Timer}
      badge={translate('components.orchestration.workerAutoClose.temporaryBadge', 'Temporary')}
      title={title}
      primaryAction={
        <Button type="button" variant="default" size="xs" onClick={keepOpen}>
          {workerKeepOpenLabel()}
        </Button>
      }
    />
  )
}
