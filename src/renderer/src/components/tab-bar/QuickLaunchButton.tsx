import { readAgentMenuTerminalPending } from './agent-menu-launch-facts'
import { terminalPendingReason } from './new-tab-agent-menu-model'
import { useAppStore } from '@/store/index'
import { useAppStateValue } from '@/store/retained-views/app-state-view'
import { SubscribedAgentLaunchPickerMenu } from '@/components/agent/AgentLaunchPickerMenu'
import {
  agentPickerFreshLaunchInputs,
  type AgentPickerEntry,
  type AgentPickerDraft
} from '../../../../shared/agent-launch/picker/agent-launch-picker'
import React, { useCallback } from 'react'
import { toast } from 'sonner'
import { launchAgentInNewTabWithOutcome } from '@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab'

import { createNonSecureContextUuid } from '../../../../shared/non-secure-context-uuid'
import { captureNativeChatComposerFocusIntent } from '@/components/native-chat/composer/focus/native-chat-composer-focus-intent'
import {
  agentLaunchPromptOwnership,
  newAgentPromptOutcome
} from '@/lib/agent-session/launch/prompt/new-agent-prompt-outcome'
import { activeAgentNotesSendFailureMessage } from '@/lib/agent-session/messaging/terminal/active-agent-note-send-result'
import { AgentSettingsMenuItem } from '@/components/agent/AgentSettingsMenuItem'
import { TabAgentSurfaceChoiceRow } from './TabAgentSurfaceChoiceRow'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut
} from '@/components/ui/dropdown-menu'
import { getAgentCatalog } from '@/lib/agent-catalog/agent-catalog'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { useOptionalShortcutLabel } from '@/hooks/useShortcutLabel'
import { useAgentMenuShortcutLabels } from './agent-menu-shortcut-labels'
import type { AgentPickerInventorySource } from '../agent/use-agent-launch-picker-inventory'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { LaunchSource } from '../../../../shared/telemetry-events'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { cn } from '@/lib/class-names'
import type { NewTabAgentMenuRow } from '../../../../shared/agent-launch/picker/agent-launch-picker-rows'
import { useNewTabAgentMenuRows, type NewTabAgentMenuModel } from './use-new-tab-agent-menu-rows'
import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import { useHermesProfiles } from '@/hooks/useHermesProfiles'
import { HermesProfileMenuItems } from '@/components/agent/HermesProfileMenuItems'
import { projectAgentLaunchProfile } from '../../../../shared/agent-launch/choices/agent-launch-profile'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { withHermesProfileArgs } from '../../../../shared/hermes-profiles'
import { chatUnavailableLabel, rowTitle, rowLabel, rowId } from './tab-agent-row-presentation'

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
  /** Called after a prompt is queued into the agent, or immediately for argv prompt launches. */
  onPromptDelivered?: () => void
  /** Given the launch's own delivery result while the prompt is still on its way. */
  onPromptHandedOff?: (delivered: Promise<unknown>) => void
  /** Nothing to send: e.g. every note is already on its way, so no agent is started. */
  disabled?: boolean
}

const PLACEHOLDER_WIDTHS = ['w-3/5', 'w-1/2', 'w-2/3', 'w-2/5', 'w-3/4', 'w-1/3', 'w-4/5', 'w-1/4']

function getCatalogEntry(agent: TuiAgent): { id: TuiAgent; label: string } | null {
  return getAgentCatalog().find((a) => a.id === agent) ?? null
}

export function useTabAgentMenuLaunch({
  worktreeId,
  groupId,
  onFocusTerminal,
  prompt,
  promptDelivery,
  launchSource,
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
          readAgentMenuTerminalPending(useAppStore.getState(), { worktreeId }))
      ) {
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
      onPromptDelivered,
      onPromptHandedOff,
      disabled,
      onFocusHostTerminal,
      onFocusChat
    ]
  )

  return runLaunch
}

function QuickLaunchAgentMenuItemsInner(props: QuickLaunchAgentMenuItemsProps): React.JSX.Element {
  useUiLanguageRevision()
  const detectionTarget = useAgentDetectionTargetForWorktree(props.worktreeId)
  const model = useNewTabAgentMenuRows(props.worktreeId, true, detectionTarget)
  const runLaunch = useTabAgentMenuLaunch(props)
  return <ProjectedAgentMenuItems {...props} model={model} runLaunch={runLaunch} />
}

export function ProjectedAgentMenuItems({
  disabled = false,
  model,
  runLaunch,
  pickerInventory,
  onSelectPickerAgent,
  hidePickerSearch
}: {
  disabled?: boolean
  model: NewTabAgentMenuModel
  runLaunch: React.ComponentProps<typeof SubscribedAgentLaunchPickerMenu>['runLaunch']
  pickerInventory?: AgentPickerInventorySource
  onSelectPickerAgent?: (agent: AgentPickerEntry['agent']) => void
  hidePickerSearch?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const desktopDefaultAgent = useAppStateValue((s) => s.settings?.defaultTuiAgent)
  const newAgentShortcut = useOptionalShortcutLabel('tab.newAgent')
  const shortcutLabels = useAgentMenuShortcutLabels(pickerInventory ? model : undefined)
  const openAgentSettings = useCallback(() => {
    useAppStore.getState().openSettingsTarget({ pane: 'agents', repoId: null })
    useAppStore.getState().openSettingsPage()
  }, [])
  const localHermes =
    model.state === 'settled' && model.pickerContext?.executionHostId === LOCAL_EXECUTION_HOST_ID
  const hermesProfiles = useHermesProfiles(localHermes)
  const launchHermesProfile = useCallback(
    (row: NewTabAgentMenuRow, profile: string | null) => {
      const settings = model.state === 'settled' ? model.pickerContext?.settings : undefined
      const baseArgs = projectAgentLaunchProfile('hermes', settings, {
        target: 'terminal'
      }).args
      return runLaunch(row, {
        agent: 'hermes',
        surface: 'terminal',
        choices: {},
        arguments: withHermesProfileArgs(baseArgs, profile)
      })
    },
    [model, runLaunch]
  )
  if (model.state === 'loading') {
    // Why: rows fill in once when every answer is known, instead of reshuffling under the pointer.
    return (
      <>
        {PLACEHOLDER_WIDTHS.slice(0, model.placeholderCount).map((width) => (
          <DropdownMenuItem
            key={width}
            variant="launch"
            disabled
            aria-label={t(
              'auto.components.tab.bar.QuickLaunchButton.agentsLoading',
              'Loading agents'
            )}
          >
            <span aria-hidden="true" className="flex h-[1lh] flex-1 items-center">
              <span className={cn('h-2 rounded-full bg-muted', width)} />
            </span>
          </DropdownMenuItem>
        ))}
        <AgentSettingsMenuItem onSelect={openAgentSettings} />
      </>
    )
  }
  const {
    rows,
    detection: { detectedIds, detectionFailed, needsServerUpdate }
  } = model
  const defaultAgent = 'defaultTuiAgent' in model ? model.defaultTuiAgent : desktopDefaultAgent
  return (
    <>
      {(detectedIds === null && (detectionFailed || needsServerUpdate)) || rows.length === 0 ? (
        <DropdownMenuItem variant="launch" disabled>
          <span className="font-normal text-muted-foreground">
            {needsServerUpdate
              ? t(
                  'auto.components.tab.bar.QuickLaunchButton.terminalListNeedsServerUpdate',
                  'Update Orca on this server to list terminal agents'
                )
              : detectionFailed
                ? t(
                    'auto.components.tab.bar.QuickLaunchButton.terminalListFailed',
                    'Couldn’t list terminal agents for this workspace'
                  )
                : detectedIds && detectedIds.length > 0
                  ? t('auto.components.tab.bar.QuickLaunchButton.8dea9b5cdf', 'No enabled agents')
                  : t('auto.components.tab.bar.QuickLaunchButton.e518f544b1', 'No agents detected')}
          </span>
        </DropdownMenuItem>
      ) : null}
      {pickerInventory ? (
        <SubscribedAgentLaunchPickerMenu
          shortcutLabels={shortcutLabels}
          model={model}
          inventory={pickerInventory}
          runLaunch={runLaunch}
          onSelectAgent={onSelectPickerAgent}
          hideSearch={hidePickerSearch}
        />
      ) : (
        rows.map((row, index) => {
          const { agent } = row
          const label = getCatalogEntry(agent)?.label ?? agent
          // Chat rows come first; the rows that open a terminal start their own group.
          const startsCliGroup = row.kind === 'cli' && index > 0 && rows[index - 1]?.kind !== 'cli'
          if (row.kind === 'chat-unavailable') {
            return (
              <DropdownMenuItem key={rowId(row)} variant="launch" disabled>
                <AgentIcon agent={agent} size={14} />
                <span className="flex-1">{label}</span>
                <span className="font-normal text-muted-foreground">
                  {chatUnavailableLabel(row.reason, t)}
                </span>
              </DropdownMenuItem>
            )
          }
          const showsDefaultAgentShortcut =
            newAgentShortcut !== null && defaultAgent !== 'blank' && agent === defaultAgent
          const pendingReason = terminalPendingReason(model.terminalPending, row, t)
          const rowContent = (
            <>
              <AgentIcon agent={agent} size={14} />
              <span className="min-w-0 flex-1 truncate">{rowLabel(row, t)}</span>
              {pendingReason ? (
                <span className="min-w-0 shrink truncate text-xs text-muted-foreground">
                  {pendingReason}
                </span>
              ) : null}
              {showsDefaultAgentShortcut ? (
                <DropdownMenuShortcut>{newAgentShortcut}</DropdownMenuShortcut>
              ) : null}
            </>
          )
          const other = otherSurfaceRow(row, detectedIds)
          if (
            !other &&
            agent === 'hermes' &&
            (row.kind === 'cli' || row.kind === 'terminal') &&
            hermesProfiles.profiles.length > 0
          ) {
            return (
              <React.Fragment key={rowId(row)}>
                {startsCliGroup ? <DropdownMenuSeparator /> : null}
                <HermesProfileMenuItems
                  snapshot={hermesProfiles}
                  disabled={disabled || !!pendingReason}
                  onSelect={(profile) => launchHermesProfile(row, profile)}
                />
              </React.Fragment>
            )
          }
          return (
            <React.Fragment key={rowId(row)}>
              {startsCliGroup ? <DropdownMenuSeparator /> : null}
              {other ? (
                <TabAgentSurfaceChoiceRow
                  row={row}
                  other={other}
                  label={label}
                  terminalPending={model.terminalPending}
                  disabled={disabled}
                  runLaunch={runLaunch}
                >
                  {rowContent}
                </TabAgentSurfaceChoiceRow>
              ) : (
                <DropdownMenuItem
                  variant="launch"
                  disabled={disabled || !!pendingReason}
                  aria-description={pendingReason}
                  onSelect={(event) => {
                    if (runLaunch(row) === false) {
                      event.preventDefault()
                    }
                  }}
                  title={rowTitle(row, label, t)}
                >
                  {rowContent}
                </DropdownMenuItem>
              )}
            </React.Fragment>
          )
        })
      )}
      <AgentSettingsMenuItem onSelect={openAgentSettings} />
    </>
  )
}

/** The same agent on the other surface: a chat's detected CLI, or a CLI-set agent's chat. */
function otherSurfaceRow(
  row: Exclude<NewTabAgentMenuRow, { kind: 'chat-unavailable' }>,
  detectedIds: readonly TuiAgent[] | null
): NewTabAgentMenuRow | null {
  const { agent, executionHostId } = row
  if (row.kind === 'chat') {
    return detectedIds?.includes(agent) ? { kind: 'cli', agent, executionHostId } : null
  }
  return row.kind === 'cli' && row.chat ? { kind: 'chat', agent, executionHostId } : null
}

export const QuickLaunchAgentMenuItems = React.memo(QuickLaunchAgentMenuItemsInner)
