import { useCallback, useMemo } from 'react'
import type { TabGroup, TerminalTab } from '../../../../shared/types'
import { useColdParkedTerminalPresentation } from './use-cold-parked-terminal-presentation'

type TerminalOverlayAssignment = {
  groupId: string
  isActiveInGroup: boolean
}

export function useTerminalOverlayPresentation(args: {
  groups: readonly TabGroup[]
  terminalTabs: readonly TerminalTab[]
  assignments: ReadonlyMap<string, TerminalOverlayAssignment>
  coldParkedTerminalTabIds: ReadonlySet<string>
  isWorktreeActive: boolean
  activeGroupId: string | undefined
  onInitialTerminalRenderSettled?: (tabId: string) => void
}): {
  presentedTerminalTabIdByGroup: ReadonlyMap<string, string | null>
  handleInitialRenderSettled: (tabId: string) => void
} {
  const {
    groups,
    terminalTabs,
    assignments,
    coldParkedTerminalTabIds,
    isWorktreeActive,
    activeGroupId,
    onInitialTerminalRenderSettled
  } = args
  const desiredTerminalTabByGroup = useMemo(() => {
    const desired = new Map<string, string | null>()
    for (const group of groups) {
      desired.set(group.id, null)
    }
    for (const terminalTab of terminalTabs) {
      const assignment = assignments.get(terminalTab.id)
      if (assignment?.isActiveInGroup) {
        desired.set(assignment.groupId, terminalTab.id)
      }
    }
    return desired
  }, [assignments, groups, terminalTabs])
  const availableTerminalTabIds = useMemo(
    () => new Set(terminalTabs.map((terminalTab) => terminalTab.id)),
    [terminalTabs]
  )
  const { presentationByScope, settleTarget } = useColdParkedTerminalPresentation({
    desiredTargetByScope: desiredTerminalTabByGroup,
    coldParkedTargetIds: coldParkedTerminalTabIds,
    availableTargetIds: availableTerminalTabIds
  })
  const presentedTerminalTabIdByGroup = useMemo(
    () =>
      new Map(
        Array.from(presentationByScope, ([groupId, entry]) => [groupId, entry.presentedTargetId])
      ),
    [presentationByScope]
  )
  const handleInitialRenderSettled = useCallback(
    (tabId: string) => {
      settleTarget(tabId)
      const assignment = assignments.get(tabId)
      if (isWorktreeActive && assignment?.isActiveInGroup && assignment.groupId === activeGroupId) {
        onInitialTerminalRenderSettled?.(tabId)
      }
    },
    [activeGroupId, assignments, isWorktreeActive, onInitialTerminalRenderSettled, settleTarget]
  )

  return {
    presentedTerminalTabIdByGroup,
    handleInitialRenderSettled
  }
}
