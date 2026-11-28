import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { useWorkerAutoClose } from '@/runtime/agent-orchestration/worker-auto-close'
import { useTranslate } from '@/i18n/use-translate'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { PaneTopWarningBanner } from '../appearance/pane-top-banner/PaneTopWarningBanner'
import { workerAutoCloseBannerProps } from './worker-auto-close-banner'

/** Across a temporary orchestration worker's pane, or a terminal that closes with it: when, and Keep open. */
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
  const t = useTranslate()
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
  const { state, nowMs, keepOpen } = useWorkerAutoClose(
    target,
    subject,
    paneKey,
    isVisible,
    worktreeId
  )
  const banner = workerAutoCloseBannerProps(state, nowMs, keepOpen, t, environmentId)
  return banner ? <PaneTopWarningBanner {...banner} /> : null
}
