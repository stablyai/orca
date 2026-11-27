import { useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { shallow } from 'zustand/shallow'
import { useAppStore } from '@/store/index'
import { useAppStoreWithHostStatuses } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import { deriveRunningAgentSendTargets } from '@/lib/agent-session/messaging/running-agent-targets'
import { agentSendDisabledReasonLabel } from '@/lib/agent-session/messaging/agent-send-disabled-reason-label'
import { recomputeOn } from '@/lib/recompute-on'
import { useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import {
  selectSendTargetControlInputs,
  selectSendTargetInputs
} from './worktree-card-send-target-inputs'
import type { SendTarget } from './worktree-agent-branch-context'

/** Per-pane picker state for the open send-target mode; null unless the mode targets this workspace. */
export function useWorktreeSendTargets(worktreeId: string | null): {
  targets: Map<string, SendTarget> | null
  onSend: (paneKey: string) => void
} {
  const t = useTranslate(),
    languageRevision = useUiLanguageRevision()
  const send = useAppStore((s) => s.sendPromptToSidebarAgentTarget)
  const control = useAppStore(useShallow((s) => selectSendTargetControlInputs(s, worktreeId ?? '')))
  const inputs = useAppStoreWithHostStatuses(
    (s, statuses) => selectSendTargetInputs(s, statuses, worktreeId ?? ''),
    shallow
  )
  const targets = useMemo(
    () =>
      recomputeOn([languageRevision], () => {
        if (!control.targetMode || !worktreeId) {
          return null
        }
        return new Map<string, SendTarget>(
          deriveRunningAgentSendTargets(inputs, worktreeId).map((target) => [
            target.paneKey,
            control.targetMode?.status === 'sending' &&
            control.targetMode.sendingPaneKey === target.paneKey
              ? {
                  status: 'sending' as const,
                  disabledReason: t(
                    'auto.components.sidebar.WorktreeCardAgents.sendingTarget',
                    'Sending...'
                  )
                }
              : {
                  status: target.status,
                  ...(target.disabledReason
                    ? { disabledReason: agentSendDisabledReasonLabel(target.disabledReason) }
                    : {})
                }
          ])
        )
      }),
    [control, inputs, worktreeId, t, languageRevision]
  )
  const onSend = useCallback(
    (key: string) => {
      void send(key)
    },
    [send]
  )
  return { targets, onSend }
}
