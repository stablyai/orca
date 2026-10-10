import React, { useCallback } from 'react'
import { Settings as SettingsIcon } from 'lucide-react'
import { toast } from 'sonner'
import { DropdownMenuItem, DropdownMenuShortcut } from '@/components/ui/dropdown-menu'
import { getAgentCatalog, AgentIcon } from '@/lib/agent-catalog'
import { useAppStore } from '@/store'
import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import { useOptionalShortcutLabel } from '@/hooks/useShortcutLabel'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { LaunchSource } from '../../../../shared/telemetry-events'
import {
  DEFAULT_DISABLED_TUI_AGENTS,
  filterEnabledTuiAgents
} from '../../../../shared/tui-agent-selection'
import { translate } from '@/i18n/i18n'
import { newAgentPromptOutcome } from '@/lib/new-agent-prompt-outcome'
import { activeAgentNotesSendFailureMessage } from '@/lib/active-agent-note-send-result'

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

function getCatalogEntry(agent: TuiAgent): { id: TuiAgent; label: string } | null {
  return getAgentCatalog().find((a) => a.id === agent) ?? null
}

function orderAgents(
  defaultAgent: TuiAgent | 'blank' | null | undefined,
  detected: TuiAgent[]
): TuiAgent[] {
  const inCatalogOrder = getAgentCatalog()
    .filter((entry) => detected.includes(entry.id))
    .map((entry) => entry.id)
  if (!defaultAgent || defaultAgent === 'blank' || !inCatalogOrder.includes(defaultAgent)) {
    return inCatalogOrder
  }
  // Why: surface the user's configured default first — matches the prior
  // split-button behavior where the default agent was the primary action.
  return [defaultAgent, ...inCatalogOrder.filter((id) => id !== defaultAgent)]
}

export function shouldShowLaunchWatchdogTimeout({ hasPty }: { hasPty: boolean }): boolean {
  return !hasPty
}

function getLaunchWatchdogTimeoutMessage(label: string): string {
  return `Couldn't launch ${label} — the terminal did not start.`
}

function getTerminalLaunchState(tabId: string): { stillOpen: boolean; hasPty: boolean } {
  const state = useAppStore.getState()
  const hasPtyBinding = (state.ptyIdsByTabId[tabId]?.length ?? 0) > 0
  let stillOpen = false
  let tabPtyId: string | null = null

  for (const tabs of Object.values(state.tabsByWorktree)) {
    const tab = tabs.find((t) => t.id === tabId)
    if (tab) {
      stillOpen = true
      tabPtyId = tab.ptyId
      break
    }
  }

  return { stillOpen, hasPty: hasPtyBinding || tabPtyId !== null }
}

async function waitForTerminalPty(tabId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const launchState = getTerminalLaunchState(tabId)
    if (launchState.hasPty) {
      return true
    }
    await new Promise((resolve) => window.setTimeout(resolve, 100))
  }
  return getTerminalLaunchState(tabId).hasPty
}

function QuickLaunchAgentMenuItemsInner({
  worktreeId,
  groupId,
  onFocusTerminal,
  prompt,
  promptDelivery,
  launchSource,
  onPromptDelivered,
  onPromptHandedOff,
  disabled = false
}: QuickLaunchAgentMenuItemsProps): React.JSX.Element | null {
  // Why: resolving only the SSH connectionId here made paired-runtime
  // worktrees fall back to LOCAL detection, listing the client's agents
  // instead of the remote server's. Use the same ssh/runtime/local owner
  // resolution as the rest of the tab bar.
  const agentDetectionTarget = useAgentDetectionTargetForWorktree(worktreeId)
  const { detectedIds, detectionFailed, needsServerUpdate } =
    useDetectedAgents(agentDetectionTarget)
  const defaultAgent = useAppStore((s) => s.settings?.defaultTuiAgent)
  const disabledAgents = useAppStore(
    (s) => s.settings?.disabledTuiAgents ?? DEFAULT_DISABLED_TUI_AGENTS
  )
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const newAgentShortcut = useOptionalShortcutLabel('tab.newAgent')

  const openAgentSettings = useCallback(() => {
    openSettingsTarget({ pane: 'agents', repoId: null })
    openSettingsPage()
  }, [openSettingsPage, openSettingsTarget])

  const runLaunch = useCallback(
    (agent: TuiAgent) => {
      if (disabled) {
        return
      }
      const entry = getCatalogEntry(agent)
      const label = entry?.label ?? agent
      const result = launchAgentInNewTab({
        requestId: newAgentLaunchRequestId(),
        agent,
        worktreeId,
        groupId,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(promptDelivery !== undefined ? { promptDelivery } : {}),
        ...(launchSource !== undefined ? { launchSource } : {}),
        ...(onPromptDelivered !== undefined ? { onPromptDelivered } : {}),
        // Notes keep their text until it goes out, so the new chat's composer never gets a copy.
        ...(onPromptHandedOff ? { promptKeptByCaller: true as const } : {}),
        freshNewTab: true
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
      if (result.surface.kind !== 'local-terminal') {
        return
      }
      onFocusTerminal(result.surface.tabId)

      // Why: launch success means the terminal session exists. Agent readiness
      // can lag behind on slow machines, and prompt paste flows already own
      // their own readiness timeout once a PTY exists.
      const launchedTabId = result.surface.tabId
      void waitForTerminalPty(launchedTabId, 5000).then((hasPty) => {
        if (hasPty) {
          return
        }
        const launchState = getTerminalLaunchState(launchedTabId)
        if (!launchState.stillOpen) {
          return
        }
        if (useAppStore.getState().activeWorktreeId !== worktreeId) {
          return
        }
        if (!shouldShowLaunchWatchdogTimeout({ hasPty: launchState.hasPty })) {
          return
        }
        toast.message(getLaunchWatchdogTimeoutMessage(label))
      })
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
      disabled
    ]
  )

  const enabledDetectedIds = detectedIds ? filterEnabledTuiAgents(detectedIds, disabledAgents) : []
  const agents = detectedIds ? orderAgents(defaultAgent, enabledDetectedIds) : []

  return (
    <>
      {agents.length === 0 ? (
        <DropdownMenuItem
          disabled
          className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 text-muted-foreground"
        >
          {needsServerUpdate
            ? translate(
                'auto.components.tab.bar.QuickLaunchButton.needsServerUpdate',
                'Update Orca on this server to list this workspace’s agents'
              )
            : detectionFailed
              ? translate(
                  'auto.components.tab.bar.QuickLaunchButton.hostUnreachable',
                  'Can’t reach this workspace’s host to list its agents'
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
      {agents.map((agent) => {
        const entry = getCatalogEntry(agent)
        const label = entry?.label ?? agent
        const showsDefaultAgentShortcut =
          newAgentShortcut !== null && defaultAgent !== 'blank' && agent === defaultAgent
        return (
          <DropdownMenuItem
            key={agent}
            disabled={disabled}
            onSelect={() => runLaunch(agent)}
            className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
            title={translate(
              'auto.components.tab.bar.QuickLaunchButton.ec2adf093e',
              'Launch {{value0}} in a new terminal',
              { value0: label }
            )}
          >
            <AgentIcon agent={agent} size={14} />
            <span className="flex-1">{label}</span>
            {showsDefaultAgentShortcut ? (
              <DropdownMenuShortcut>{newAgentShortcut}</DropdownMenuShortcut>
            ) : null}
          </DropdownMenuItem>
        )
      })}
      <DropdownMenuItem
        onSelect={openAgentSettings}
        className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium text-muted-foreground"
      >
        <SettingsIcon className="size-4" />
        {translate('auto.components.tab.bar.QuickLaunchButton.348a04c1ad', 'Agent settings…')}
      </DropdownMenuItem>
    </>
  )
}

export const QuickLaunchAgentMenuItems = React.memo(QuickLaunchAgentMenuItemsInner)
