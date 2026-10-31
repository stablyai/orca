import { AgentLaunchPickerMenu } from '@/components/agent/AgentLaunchPickerMenu'
import {
  agentPickerLaunchInputs,
  type AgentPickerEntry,
  type AgentPickerDraft
} from '../../../../shared/agent-launch-picker'
import React, { useCallback } from 'react'
import { toast } from 'sonner'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { launchWithClaudeAccountChoice } from '../claude-account-prompt/choose-claude-launch-account'
import { captureNativeChatComposerFocusIntent } from '@/components/native-chat/use-native-chat-composer-reveal-focus'
import type { NativeChatComposerFocusIntent } from '@/components/native-chat/use-native-chat-composer-reveal-focus'
import { newAgentPromptOutcome } from '@/lib/new-agent-prompt-outcome'
import { activeAgentNotesSendFailureMessage } from '@/lib/active-agent-note-send-result'
import { Settings as SettingsIcon } from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut
} from '@/components/ui/dropdown-menu'
import { getAgentCatalog, AgentIcon } from '@/lib/agent-catalog'
import { useAppStore } from '@/store'
import { useOptionalShortcutLabel } from '@/hooks/useShortcutLabel'
import { useAgentMenuShortcutLabels } from './agent-menu-shortcut-labels'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { LaunchSource } from '../../../../shared/telemetry-events'
import { translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { cn } from '@/lib/utils'
import type { NewTabAgentMenuRow } from '@/lib/new-tab-agent-menu-rows'
import { useNewTabAgentMenuRows, type NewTabAgentMenuModel } from './use-new-tab-agent-menu-rows'
import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import { chatUnavailableLabel, rowTitle, rowLabel, rowId } from './tab-agent-row-presentation'
import { otherSurfaceRow, SurfaceChoiceRow } from './agent-surface-choice-row'

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

type NewTabLaunchableRow = Exclude<NewTabAgentMenuRow, { kind: 'chat-unavailable' }>

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
  onFocusChat,
  afterDeferredLaunch
}: QuickLaunchAgentMenuItemsProps & {
  onFocusHostTerminal?: () => void
  /** A New Chat opened at once: its composer takes the focus the menu gives back. */
  onFocusChat?: (tabId: string) => void
  /** Runs after a launch the Claude account prompt delayed past the menu's close. */
  afterDeferredLaunch?: () => void
}) {
  const launchOnAccount = useCallback(
    (
      row: NewTabLaunchableRow,
      focusIntent: NativeChatComposerFocusIntent,
      claudeAccountId: string | undefined,
      deferred: boolean,
      draft?: AgentPickerDraft,
      pickerEntry?: AgentPickerEntry
    ) => {
      const { agent } = row
      const entry = getCatalogEntry(agent)
      const label = entry?.label ?? agent
      const result = launchAgentInNewTab({
        requestId: newAgentLaunchRequestId(),
        focusIntent,
        ...(claudeAccountId ? { claudeAccountId } : {}),
        ...(row.kind === 'chat' || row.kind === 'cli'
          ? {
              requestedSurface: row.kind === 'chat' ? ('chat' as const) : ('terminal' as const),
              selectedExecutionHostId: row.executionHostId
            }
          : {}),
        agent,
        ...(draft ? agentPickerLaunchInputs(draft, pickerEntry) : {}),
        worktreeId,
        groupId,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(promptDelivery !== undefined ? { promptDelivery } : {}),
        ...(launchSource !== undefined ? { launchSource } : {}),
        ...(onPromptDelivered !== undefined ? { onPromptDelivered } : {}),
        // Notes keep their text until it goes out, so the new chat's composer never gets a copy.
        ...(onPromptHandedOff ? { promptKeptByCaller: true as const } : {})
      })
      if (!result) {
        toast.error(
          translate(
            'auto.components.tab.bar.QuickLaunchButton.465e432ef1',
            'Could not build launch command for {{value0}}.',
            { value0: label }
          )
        )
        return
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
        return
      }
      if (result.surface.kind !== 'local-terminal') {
        onFocusHostTerminal?.()
        return
      }
      // Why: after the account prompt the menu has closed, so a queued focus runs only if flushed.
      if (deferred && !afterDeferredLaunch) {
        focusTerminalTabSurface(result.surface.tabId)
      } else {
        onFocusTerminal(result.surface.tabId)
      }
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
      onFocusHostTerminal,
      onFocusChat,
      afterDeferredLaunch
    ]
  )

  return useCallback(
    (row: NewTabAgentMenuRow, draft?: AgentPickerDraft, pickerEntry?: AgentPickerEntry) => {
      if (disabled || row.kind === 'chat-unavailable') {
        return
      }
      // Why captured before the account prompt: the prompt itself takes focus.
      const focusIntent = captureNativeChatComposerFocusIntent()
      launchWithClaudeAccountChoice(
        row.agent,
        { worktreeId, afterDeferredLaunch },
        (claudeAccountId, deferred) =>
          launchOnAccount(row, focusIntent, claudeAccountId, deferred, draft, pickerEntry)
      )
    },
    [disabled, worktreeId, afterDeferredLaunch, launchOnAccount]
  )
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
  pickerEntries,
  onSelectPickerAgent,
  hidePickerSearch
}: {
  disabled?: boolean
  model: NewTabAgentMenuModel
  runLaunch: (row: NewTabAgentMenuRow, draft?: AgentPickerDraft) => void
  pickerEntries?: AgentPickerEntry[]
  onSelectPickerAgent?: (agent: AgentPickerEntry['agent']) => void
  hidePickerSearch?: boolean
}): React.JSX.Element {
  const desktopDefaultAgent = useAppStore((s) => s.settings?.defaultTuiAgent)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const newAgentShortcut = useOptionalShortcutLabel('tab.newAgent')
  const shortcutLabels = useAgentMenuShortcutLabels(pickerEntries ? model : undefined)
  const openAgentSettings = useCallback(() => {
    openSettingsTarget({ pane: 'agents', repoId: null })
    openSettingsPage()
  }, [openSettingsPage, openSettingsTarget])
  if (model.state === 'loading') {
    // Why: rows fill in once when every answer is known, instead of reshuffling under the pointer.
    return (
      <>
        {PLACEHOLDER_WIDTHS.slice(0, model.placeholderCount).map((width) => (
          <DropdownMenuItem
            key={width}
            variant="launch"
            disabled
            aria-label={translate(
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
        <DropdownMenuItem
          disabled
          className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 text-muted-foreground"
        >
          {needsServerUpdate
            ? translate(
                'auto.components.tab.bar.QuickLaunchButton.terminalListNeedsServerUpdate',
                'Update Orca on this server to list terminal agents'
              )
            : detectionFailed
              ? translate(
                  'auto.components.tab.bar.QuickLaunchButton.terminalListFailed',
                  'Couldn’t list terminal agents for this workspace'
                )
              : detectedIds && detectedIds.length > 0
                ? translate(
                    'auto.components.tab.bar.QuickLaunchButton.8dea9b5cdf',
                    'No enabled agents'
                  )
                : translate(
                    'auto.components.tab.bar.QuickLaunchButton.e518f544b1',
                    'No agents detected'
                  )}
        </DropdownMenuItem>
      ) : null}
      {pickerEntries ? (
        <AgentLaunchPickerMenu
          shortcutLabels={shortcutLabels}
          entries={pickerEntries}
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
                  {chatUnavailableLabel(row.reason)}
                </span>
              </DropdownMenuItem>
            )
          }
          const showsDefaultAgentShortcut =
            newAgentShortcut !== null && defaultAgent !== 'blank' && agent === defaultAgent
          const rowContent = (
            <>
              <AgentIcon agent={agent} size={14} />
              <span className="flex-1">{rowLabel(row)}</span>
              {showsDefaultAgentShortcut ? (
                <DropdownMenuShortcut>{newAgentShortcut}</DropdownMenuShortcut>
              ) : null}
            </>
          )
          const other = otherSurfaceRow(row, detectedIds)
          return (
            <React.Fragment key={rowId(row)}>
              {startsCliGroup ? <DropdownMenuSeparator /> : null}
              {other ? (
                <SurfaceChoiceRow
                  row={row}
                  other={other}
                  label={label}
                  disabled={disabled}
                  runLaunch={runLaunch}
                >
                  {rowContent}
                </SurfaceChoiceRow>
              ) : (
                <DropdownMenuItem
                  variant="launch"
                  disabled={disabled}
                  onSelect={() => runLaunch(row)}
                  title={rowTitle(row, label)}
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

function AgentSettingsMenuItem({ onSelect }: { onSelect: () => void }): React.JSX.Element {
  return (
    <DropdownMenuItem
      onSelect={onSelect}
      className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium text-muted-foreground"
    >
      <SettingsIcon className="size-4" />
      {translate('auto.components.tab.bar.QuickLaunchButton.348a04c1ad', 'Agent settings…')}
    </DropdownMenuItem>
  )
}

export const QuickLaunchAgentMenuItems = React.memo(QuickLaunchAgentMenuItemsInner)
