// Delete chat, the one flow every chat row's menu uses: the host that owns the chat deletes it.
import { useCallback } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { persistConfirmationSkipPreference } from '@/components/dismiss/confirmation/confirmation-skip-preference'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/rpc/targets/runtime-client-target'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import { lastVerifiedRuntimeStatus } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { useRuntimeHostStatusSelector } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import { useAppStore } from '@/store'
import {
  parseRoutableExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import {
  AGENT_SESSION_DELETE_RUNTIME_CAPABILITY,
  type OrcaChatDeleteRefusal,
  type OrcaChatDeleteResult
} from '../../../../../shared/agent-session/chat-deletion/orca-chat-delete'

export type OrcaChatDeleteTarget = {
  /** The host that owns the chat's store. */
  hostId: ExecutionHostId
  sessionId: string
  /** A bot's live Home Chat is cleared: a fresh Home takes its place. */
  home?: { botName: string }
}

const SETTINGS_SECTION_ID = 'general-skip-delete-chat-confirm'

function runtimeEnvironmentOf(hostId: ExecutionHostId): string | null {
  const host = parseRoutableExecutionHostId(hostId)
  return host?.kind === 'runtime' ? host.environmentId : null
}

function hostUpdateReason(hostLabel: string, t: Translate = translate): string {
  return t('chats.delete.updateHost', 'Update {{host}} to delete chats', { host: hostLabel })
}

/** Why Delete is off for a chat whose state is known here; null when it can be asked. */
export function orcaChatDeleteBlockedReason(
  state: { replying: boolean; workersRunning: boolean },
  t: Translate = translate
): string | null {
  if (state.replying) {
    return t('chats.delete.replying', 'Replying now')
  }
  if (state.workersRunning) {
    return t('chats.delete.workersRunning', 'Workers still running')
  }
  return null
}

function refusalText(reason: OrcaChatDeleteRefusal): string {
  return reason === 'replying' || reason === 'workers'
    ? orcaChatDeleteBlockedReason({ replying: reason === 'replying', workersRunning: true })!
    : translate('chats.delete.failed', "Couldn't delete the chat")
}

/** Why the host can't delete chats: an older paired server. Null while unknown, so a click asks. */
export function useOrcaChatDeleteHostReason(hostId: ExecutionHostId): string | null {
  const environmentId = runtimeEnvironmentOf(hostId)
  const label = useAppStore((s) => selectExecutionHostDisplayLabel(s, hostId))
  const lacksDelete = useRuntimeHostStatusSelector(environmentId, (entry) => {
    const capabilities = environmentId ? lastVerifiedRuntimeStatus(entry)?.capabilities : null
    return capabilities ? !capabilities.includes(AGENT_SESSION_DELETE_RUNTIME_CAPABILITY) : false
  })
  return lacksDelete ? hostUpdateReason(label) : null
}

/** Confirms, unless the owner chose not to be asked, then deletes on the chat's host. True once deleted. */
export function useDeleteOrcaChat(): (target: OrcaChatDeleteTarget) => Promise<boolean> {
  const confirm = useConfirmationDialog()
  return useCallback(
    async (target) => {
      const state = useAppStore.getState()
      const environmentId = runtimeEnvironmentOf(target.hostId)
      const hostLabel = environmentId ? selectExecutionHostDisplayLabel(state, target.hostId) : null
      const callTarget = ipcOrRuntimeTargetForHostId(target.hostId)
      if (!callTarget) {
        return false
      }
      if (
        environmentId &&
        hostLabel &&
        !(await runtimeEnvironmentSupportsCapability(
          environmentId,
          AGENT_SESSION_DELETE_RUNTIME_CAPABILITY
        ).catch(() => true))
      ) {
        toast.error(hostUpdateReason(hostLabel))
        return false
      }
      if (!state.settings?.skipDeleteChatConfirm) {
        const undone = translate('chats.delete.undone', "This can't be undone.")
        const confirmed = await confirm({
          ...(target.home
            ? {
                title: translate('chats.clear.title', 'Clear Home Chat?'),
                description: hostLabel
                  ? translate(
                      'chats.clear.descriptionHost',
                      "{{name}} starts a fresh Home Chat and keeps its soul and memory. This conversation is deleted permanently from {{host}}. This can't be undone.",
                      { name: target.home.botName, host: hostLabel }
                    )
                  : translate(
                      'chats.clear.description',
                      "{{name}} starts a fresh Home Chat and keeps its soul and memory. This conversation is deleted. This can't be undone.",
                      { name: target.home.botName }
                    ),
                confirmLabel: translate('chats.clear.action', 'Clear chat')
              }
            : {
                title: translate('chats.delete.title', 'Delete this chat?'),
                description: hostLabel
                  ? translate(
                      'chats.delete.descriptionHost',
                      "It's deleted permanently from {{host}}. This can't be undone.",
                      { host: hostLabel }
                    )
                  : undone,
                confirmLabel: translate('chats.delete.action', 'Delete')
              }),
          confirmVariant: 'destructive',
          dontAskAgain: {
            onConfirmed: () =>
              persistConfirmationSkipPreference({
                updates: { skipDeleteChatConfirm: true },
                settingsSectionId: SETTINGS_SECTION_ID,
                updateSettings: state.updateSettings,
                openSettingsPage: state.openSettingsPage,
                openSettingsTarget: state.openSettingsTarget
              })
          }
        })
        if (!confirmed) {
          return false
        }
      }
      try {
        const result = await callStructuredAgentSession<OrcaChatDeleteResult>(
          callTarget,
          'agentSession.delete',
          { sessionId: target.sessionId }
        )
        if (result.outcome === 'deleted') {
          return true
        }
        toast.error(refusalText(result.reason))
      } catch {
        toast.error(translate('chats.delete.failed', "Couldn't delete the chat"))
      }
      return false
    },
    [confirm]
  )
}
