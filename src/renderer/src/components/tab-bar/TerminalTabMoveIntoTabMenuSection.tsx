import { Columns2, PanelBottomClose, PanelRightClose } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import {
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { moveTerminalTabIntoPaneInApp } from '@/components/terminal-pane/terminal-tab-into-pane-deps'
import {
  isSourceWideRefusal,
  resolveTerminalTabIntoPaneEligibility,
  type TerminalTabIntoPaneEligibility,
  type TerminalTabIntoPaneState
} from '@/components/terminal-pane/terminal-tab-into-pane-eligibility'
import { describeTerminalTabIntoPaneRefusal } from '@/components/terminal-pane/terminal-tab-into-pane-reasons'
import { useAppStore } from '../../store'
import type { AppState } from '../../store/types'

function selectMoveIntoTabInputs(
  state: AppState
): TerminalTabIntoPaneState & Pick<AppState, 'tabBarOrderByWorktree'> {
  return {
    tabsByWorktree: state.tabsByWorktree,
    terminalLayoutsByTabId: state.terminalLayoutsByTabId,
    pendingStartupByTabId: state.pendingStartupByTabId,
    automaticAgentResumeClaimsByTabId: state.automaticAgentResumeClaimsByTabId,
    pendingInitialCwdByTabId: state.pendingInitialCwdByTabId,
    pendingIssueCommandSplitByTabId: state.pendingIssueCommandSplitByTabId,
    unverifiedPtyLossTabIds: state.unverifiedPtyLossTabIds,
    sleepingAgentSessionsByPaneKey: state.sleepingAgentSessionsByPaneKey,
    pendingPtyShutdownIds: state.pendingPtyShutdownIds,
    tabBarOrderByWorktree: state.tabBarOrderByWorktree
  }
}

/** "Move Into Tab": the other terminal tabs of this workspace, each with a side to join on. */
export function TerminalTabMoveIntoTabMenuSection({
  tabId,
  worktreeId
}: {
  tabId: string
  worktreeId: string
}): React.JSX.Element {
  const inputs = useAppStore(useShallow(selectMoveIntoTabInputs))
  const order = inputs.tabBarOrderByWorktree[worktreeId] ?? []
  const rank = (id: string): number => {
    const index = order.indexOf(id)
    return index === -1 ? Number.MAX_SAFE_INTEGER : index
  }
  const targets = (inputs.tabsByWorktree[worktreeId] ?? [])
    .filter((tab) => tab.id !== tabId)
    .sort((a, b) => rank(a.id) - rank(b.id) || a.sortOrder - b.sortOrder)

  const eligibilities = targets.map((target) =>
    resolveTerminalTabIntoPaneEligibility(inputs, {
      sourceTabId: tabId,
      targetTabId: target.id
    })
  )
  // A refusal that comes from the source alone would repeat on every target, so it sits on the trigger.
  const sourceRefusal = eligibilities.find(
    (eligibility): eligibility is Extract<TerminalTabIntoPaneEligibility, { ok: false }> =>
      !eligibility.ok && isSourceWideRefusal(eligibility.reason)
  )
  const titles = targets.map((target) => target.customTitle ?? target.title)
  // Same-titled tabs look identical in a menu, so they are numbered in tab-bar order.
  const labels = titles.map((title, index) => {
    if (titles.filter((candidate) => candidate === title).length === 1) {
      return title
    }
    const ordinal = titles.slice(0, index + 1).filter((candidate) => candidate === title).length
    return `${title} (${ordinal})`
  })

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        className="[&>svg:last-child]:size-3.5"
        disabled={sourceRefusal !== undefined}
      >
        <Columns2 className="size-3.5 shrink-0" />
        {translate('terminal.paneMove.moveIntoTab', 'Move Into Tab')}
        {sourceRefusal ? (
          <DropdownMenuShortcut>
            {describeTerminalTabIntoPaneRefusal(sourceRefusal.reason)}
          </DropdownMenuShortcut>
        ) : null}
      </DropdownMenuSubTrigger>
      {sourceRefusal ? null : (
        <DropdownMenuSubContent className="min-w-[12rem] max-w-[calc(100vw-1rem)] whitespace-nowrap">
          {targets.length === 0 ? (
            <DropdownMenuItem disabled>
              {translate('terminal.paneMove.noTargets', 'No other terminal tabs')}
            </DropdownMenuItem>
          ) : null}
          {targets.map((target, index) => {
            const eligibility = eligibilities[index]
            const title = labels[index]
            if (!eligibility) {
              return null
            }
            if (!eligibility.ok) {
              return (
                <DropdownMenuItem key={target.id} disabled>
                  {title}
                  <DropdownMenuShortcut>
                    {describeTerminalTabIntoPaneRefusal(eligibility.reason)}
                  </DropdownMenuShortcut>
                </DropdownMenuItem>
              )
            }
            const join = (side: 'right' | 'bottom'): void => {
              void moveTerminalTabIntoPaneInApp({
                sourceTabId: tabId,
                targetTabId: target.id,
                targetLeafId: eligibility.targetLeafId,
                side
              })
            }
            return (
              <DropdownMenuSub key={target.id}>
                <DropdownMenuSubTrigger className="[&>svg:last-child]:size-3.5">
                  {title}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-[10rem] max-w-[calc(100vw-1rem)] whitespace-nowrap">
                  <DropdownMenuItem onSelect={() => join('right')}>
                    <PanelRightClose className="size-3.5 shrink-0" />
                    {translate('terminal.paneMove.splitRight', 'Split Right')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => join('bottom')}>
                    <PanelBottomClose className="size-3.5 shrink-0" />
                    {translate('terminal.paneMove.splitDown', 'Split Down')}
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )
          })}
        </DropdownMenuSubContent>
      )}
    </DropdownMenuSub>
  )
}
