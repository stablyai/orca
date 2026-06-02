import type { ContextualTourStepAction } from '../../../../shared/contextual-tours'
import type { RequestActiveTerminalPaneSplitDetail } from '@/constants/terminal'

export function performContextualTourStepAction(args: {
  action: ContextualTourStepAction
  activeTabId: string | null
  isLastStep: boolean
  finishTour: () => void
  advanceContextualTour: () => void
  detachContextualTourSource: () => void
  setSidebarOpen: (open: boolean) => void
  openTaskPage: () => void
  openModal: (modal: 'setup-guide') => void
  canCreateWorkspace: boolean
  openWorkspaceComposer: () => void
  dispatchTerminalPaneSplit: (detail: RequestActiveTerminalPaneSplitDetail) => void
  schedule: (callback: () => void) => void
}): void {
  const advanceOrFinish = (): void => {
    if (args.isLastStep) {
      args.finishTour()
    } else {
      args.advanceContextualTour()
    }
  }

  switch (args.action.kind) {
    case 'next':
      advanceOrFinish()
      return
    case 'complete':
      args.finishTour()
      return
    case 'split-terminal-pane':
      if (args.activeTabId) {
        args.dispatchTerminalPaneSplit({ tabId: args.activeTabId, direction: 'vertical' })
      }
      return
    case 'create-worktree':
      if (args.canCreateWorkspace) {
        // Why: opening the composer cancels this tour (it isn't allowed over the
        // modal) and hands off to the workspace-creation tour. Detach first so the
        // terminal source's unmount cleanup can't record a stray suppression.
        args.detachContextualTourSource()
        args.setSidebarOpen(true)
        args.openWorkspaceComposer()
      }
      return
    case 'show-worktrees':
      args.setSidebarOpen(true)
      advanceOrFinish()
      return
    case 'open-tasks':
      // Why: the auto tour starts from the terminal, but this CTA intentionally
      // navigates to Tasks before the final setup-guide step.
      args.detachContextualTourSource()
      args.openTaskPage()
      advanceOrFinish()
      return
    case 'open-getting-started':
      args.finishTour()
      args.schedule(() => {
        args.openModal('setup-guide')
      })
  }
}
