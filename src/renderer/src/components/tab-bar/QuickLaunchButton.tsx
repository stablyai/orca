import React, { useCallback, useRef } from 'react'
import { toast } from 'sonner'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { captureNativeChatComposerFocusIntent } from '@/components/native-chat/use-native-chat-composer-reveal-focus'
import { newAgentPromptOutcome } from '@/lib/new-agent-prompt-outcome'
import { activeAgentNotesSendFailureMessage } from '@/lib/active-agent-note-send-result'
import { Settings as SettingsIcon } from 'lucide-react'
import { AgentTerminalLaunchButton } from '@/components/agent/AgentTerminalLaunchButton'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut
} from '@/components/ui/dropdown-menu'
import { getAgentCatalog, AgentIcon } from '@/lib/agent-catalog'
import { useAppStore } from '@/store'
import { useOptionalShortcutLabel } from '@/hooks/useShortcutLabel'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { LaunchSource } from '../../../../shared/telemetry-events'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { NewTabAgentMenuRow } from '@/lib/new-tab-agent-menu-rows'
import { useNewTabAgentMenuRows, type NewTabAgentMenuModel } from './use-new-tab-agent-menu-rows'
import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import { chatUnavailableLabel, rowTitle, rowLabel, rowId } from './tab-agent-row-presentation'

export type QuickLaunchAgentMenuItemsProps = {
  worktreeId: string
  groupId: string
  /** Called after the tab is created so keyboard focus lands in the new xterm.
   *  Reuses the TabBar's existing double-rAF handoff — this component does
   *  not duplicate the focus logic. */
  onFocusTerminal: (tabId: string) => void
  /** Optional initial prompt forwarded to `launchAgentInNewTab`. When set,
   *  the picked agent boots with this prompt — argv/flag agents auto-submit,
   *  followup-path agents land it as a draft for the user to confirm. */
  prompt?: string
  /** Use non-default modes for generated context that must not become shell syntax. */
  promptDelivery?: 'auto-submit' | 'draft' | 'submit-after-ready'
  /** Telemetry surface for `agent_started.launch_source`. Defaults to
   *  `'tab_bar_quick_launch'` so the existing tab-bar `+` callsite is
   *  unchanged. */
  launchSource?: LaunchSource
  /** Called after a prompt is queued into the agent, or immediately for argv prompt launches. */
  onPromptDelivered?: () => void
  /** Given the launch's own delivery result while the prompt is still on its way. */
  onPromptHandedOff?: (delivered: Promise<unknown>) => void
  /** Nothing to send: e.g. every note is already on its way, so no agent is started. */
  disabled?: boolean
}

const ROW_NAVIGATION_KEYS = new Set(['ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End'])

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
    (row: NewTabAgentMenuRow) => {
      if (disabled || row.kind === 'chat-unavailable') {
        return
      }
      const { agent } = row
      const entry = getCatalogEntry(agent)
      const label = entry?.label ?? agent
      const result = launchAgentInNewTab({
        requestId: newAgentLaunchRequestId(),
        focusIntent: captureNativeChatComposerFocusIntent(),
        ...(row.kind === 'chat' || row.kind === 'cli'
          ? {
              requestedSurface: row.kind === 'chat' ? ('chat' as const) : ('terminal' as const),
              selectedExecutionHostId: row.executionHostId
            }
          : {}),
        agent,
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
      onFocusTerminal(result.surface.tabId)
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
  const detectionTarget = useAgentDetectionTargetForWorktree(props.worktreeId)
  const model = useNewTabAgentMenuRows(props.worktreeId, true, detectionTarget)
  const runLaunch = useTabAgentMenuLaunch(props)
  return <ProjectedAgentMenuItems {...props} model={model} runLaunch={runLaunch} />
}

export function ProjectedAgentMenuItems({
  disabled = false,
  model,
  runLaunch
}: {
  disabled?: boolean
  model: NewTabAgentMenuModel
  runLaunch: (row: NewTabAgentMenuRow) => void
}): React.JSX.Element {
  const desktopDefaultAgent = useAppStore((s) => s.settings?.defaultTuiAgent)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const newAgentShortcut = useOptionalShortcutLabel('tab.newAgent')
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
      {rows.map((row, index) => {
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
        return (
          <React.Fragment key={rowId(row)}>
            {startsCliGroup ? <DropdownMenuSeparator /> : null}
            {row.kind === 'chat' && detectedIds?.includes(agent) ? (
              <ChatRow row={row} label={label} disabled={disabled} runLaunch={runLaunch}>
                {rowContent}
              </ChatRow>
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
      })}
      <AgentSettingsMenuItem onSelect={openAgentSettings} />
    </>
  )
}

// Why: the row starts the chat; its trailing button (or ArrowRight, then Enter) opens the CLI.
function ChatRow({
  row,
  label,
  disabled,
  runLaunch,
  children
}: {
  row: Extract<NewTabAgentMenuRow, { kind: 'chat' }>
  label: string
  disabled: boolean
  runLaunch: (row: NewTabAgentMenuRow) => void
  children: React.ReactNode
}): React.JSX.Element {
  const cliButton = useRef<HTMLButtonElement>(null)
  const cliRow: NewTabAgentMenuRow = { ...row, kind: 'cli' }
  const cliTitle = rowTitle(cliRow, label)
  const chatTitle = rowTitle(row, label)
  return (
    <DropdownMenuItem
      variant="launch"
      disabled={disabled}
      title={chatTitle}
      aria-label={chatTitle}
      // Why: the button's click (or a drag released on it) selects this item, so Radix closes the
      // menu either way; the pointer or focus on the button is what asks for the CLI.
      onSelect={() => {
        const button = cliButton.current
        const opensCli =
          button !== null && (button.matches(':hover') || button === document.activeElement)
        runLaunch(opensCli ? cliRow : row)
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight') {
          event.preventDefault()
          cliButton.current?.focus()
        }
      }}
    >
      {children}
      <AgentTerminalLaunchButton
        ref={cliButton}
        title={cliTitle}
        className="hover:bg-accent focus-visible:bg-accent [[data-highlighted]_&]:opacity-100"
        onKeyDown={(event) => {
          // Stopped so the row's own Enter handling does not start a chat instead.
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            event.stopPropagation()
            event.currentTarget.click()
          } else if (ROW_NAVIGATION_KEYS.has(event.key)) {
            event.preventDefault()
            event.stopPropagation()
            const item = event.currentTarget.closest<HTMLElement>('[role="menuitem"]')
            item?.focus()
            // Why: roving focus ignores keys from inside an item, so the row replays the move.
            if (event.key !== 'ArrowLeft') {
              item?.dispatchEvent(new KeyboardEvent('keydown', { key: event.key, bubbles: true }))
            }
          }
        }}
      />
    </DropdownMenuItem>
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
