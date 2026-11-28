import { useCallback } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store/index'
import { readRuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-owner'
import {
  agentPickerFreshLaunchInputs,
  type AgentPickerDraft,
  type AgentPickerEntry
} from '../../../../../shared/agent-launch/picker/agent-launch-picker'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { LaunchSource } from '../../../../../shared/telemetry/schemas/telemetry-property-schemas'
import type { NewTabAgentMenuRow } from '../../../../../shared/agent-launch/picker/agent-launch-picker-rows'
import { createNonSecureContextUuid } from '../../../../../shared/identifiers/non-secure-context-uuid'
import { launchAgentInNewTabWithOutcome } from '@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab'
import { captureNativeChatComposerFocusIntent } from '@/components/native-chat/composer/focus/native-chat-composer-focus-intent'
import {
  agentLaunchPromptOwnership,
  newAgentPromptOutcome
} from '@/lib/agent-session/launch/prompt/new-agent-prompt-outcome'
import { activeAgentNotesSendFailureMessage } from '@/lib/agent-session/messaging/terminal/active-agent-note-send-result'
import { getAgentCatalog } from '@/lib/agent-catalog/agent-catalog'
import { translate } from '@/i18n/i18n'
import { readAgentMenuTerminalPending } from './agent-menu-launch-facts'

export type QuickLaunchAgentMenuItemsProps = {
  worktreeId: string
  groupId: string
  /** Reuse the tab bar’s focus handoff after creating a terminal tab. */
  onFocusTerminal: (tabId: string) => void
  /** Forward the initial prompt; delivery policy determines submission versus a user-confirmed draft. */
  prompt?: string
  /** Use non-default modes for generated context that must not become shell syntax. */
  promptDelivery?: 'auto-submit' | 'draft' | 'submit-after-ready'
  /** Default launch telemetry to tab_bar_quick_launch. */
  launchSource?: LaunchSource
  canSendPrompt?: () => boolean
  /** Called after a prompt is queued into the agent, or immediately for argv prompt launches. */
  onPromptDelivered?: () => void
  /** Given the launch's own delivery result while the prompt is still on its way. */
  onPromptHandedOff?: (delivered: Promise<unknown>) => void
  /** Nothing to send: e.g. every note is already on its way, so no agent is started. */
  disabled?: boolean
}

export function getCatalogEntry(agent: TuiAgent): { id: TuiAgent; label: string } | null {
  return getAgentCatalog().find((a) => a.id === agent) ?? null
}

export function useTabAgentMenuLaunch({
  worktreeId,
  groupId,
  onFocusTerminal,
  prompt,
  promptDelivery,
  launchSource,
  canSendPrompt,
  onPromptDelivered,
  onPromptHandedOff,
  disabled,
  onFocusHostTerminal,
  onFocusChat
}: QuickLaunchAgentMenuItemsProps & {
  onFocusHostTerminal?: () => void
  /** A New Chat opened at once: its composer takes the focus the menu gives back. */
  onFocusChat?: (tabId: string) => void
}) {
  const runLaunch = useCallback(
    (row: NewTabAgentMenuRow, draft?: AgentPickerDraft, pickerEntry?: AgentPickerEntry) => {
      if (
        disabled ||
        row.kind === 'chat-unavailable' ||
        (row.kind !== 'chat' &&
          readAgentMenuTerminalPending(useAppStore.getState(), readRuntimeStatuses(), {
            worktreeId
          }))
      ) {
        return false
      }
      if (canSendPrompt && !canSendPrompt()) {
        return false
      }
      const { agent } = row
      const entry = getCatalogEntry(agent)
      const label = entry?.label ?? agent
      const result = launchAgentInNewTabWithOutcome({
        requestId: createNonSecureContextUuid(),
        focusIntent: captureNativeChatComposerFocusIntent(),
        ...(row.kind === 'chat' || row.kind === 'cli'
          ? {
              requestedSurface: row.kind === 'chat' ? ('chat' as const) : ('terminal' as const),
              selectedExecutionHostId: row.executionHostId
            }
          : {}),
        agent,
        ...(draft
          ? agentPickerFreshLaunchInputs(
              draft,
              {
                surface: row.kind === 'chat' ? 'chat' : 'terminal',
                executionHostId: row.executionHostId
              },
              pickerEntry
            )
          : {}),
        worktreeId,
        groupId,
        // A caller's prompt (notes) owns the launch; otherwise the picker panel's typed one.
        ...(prompt !== undefined ? { prompt } : draft?.prompt ? { prompt: draft.prompt } : {}),
        ...(promptDelivery !== undefined ? { promptDelivery } : {}),
        ...(launchSource !== undefined ? { launchSource } : {}),
        ...(onPromptDelivered !== undefined ? { onPromptDelivered } : {}),
        // Notes keep their text until it goes out, so the new chat's composer never gets a copy.
        ...(onPromptHandedOff ? { promptKeptByCaller: true as const } : {})
      })
      if (!result || 'refused' in result) {
        return false
      }
      if (onPromptHandedOff && result.promptDeliveryResult) {
        const outcome = newAgentPromptOutcome({ delivery: result.promptDeliveryResult })
        onPromptHandedOff(outcome)
        // The notes keep the text, so they say once why it did not go, as a send to a chat does.
        void outcome.then(({ failure }) => {
          if (failure) {
            toast.error(
              translate('auto.store.slices.ui.53883b7bc3', "Couldn't send to {{value0}}", {
                value0: label
              }),
              {
                description: activeAgentNotesSendFailureMessage(failure.status, {
                  explicitTarget: true,
                  code: failure.code
                })
              }
            )
          }
        })
      }
      if (result.surface.kind === 'local-chat') {
        onFocusChat?.(result.surface.tabId)
      } else if (result.surface.kind !== 'local-terminal') {
        onFocusHostTerminal?.()
      } else {
        onFocusTerminal(result.surface.tabId)
      }
      // A setup submission waits for actual prompt ownership, not just surface dispatch.
      return !draft?.prompt || agentLaunchPromptOwnership(result.promptDeliveryResult)
    },
    [
      worktreeId,
      groupId,
      onFocusTerminal,
      prompt,
      promptDelivery,
      launchSource,
      canSendPrompt,
      onPromptDelivered,
      onPromptHandedOff,
      disabled,
      onFocusHostTerminal,
      onFocusChat
    ]
  )

  return runLaunch
}
