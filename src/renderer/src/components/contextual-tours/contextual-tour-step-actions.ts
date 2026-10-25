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
  openModal: (modal: 'setup-guide', data?: Record<string, unknown>) => void
  openClientHostedBrowserSettings: () => void
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
      // Detach before composer handoff; the tour cancels over modals and source unmount must not record stray suppression.
      args.detachContextualTourSource()
      args.setSidebarOpen(true)
      args.openWorkspaceComposer()
      return
    case 'show-worktrees':
      args.setSidebarOpen(true)
      advanceOrFinish()
      return
    case 'open-tasks':
      // Detach the terminal source before the CTA navigates to Tasks for the final guide step.
      args.detachContextualTourSource()
      args.openTaskPage()
      advanceOrFinish()
      return
    case 'open-getting-started':
      args.finishTour()
      args.schedule(() => {
        args.openModal('setup-guide', { telemetrySource: 'contextual_tour' })
      })
      return
    case 'open-client-hosted-browser-settings':
      // Why: the settings page replaces the pane the tooltip is anchored to.
      args.finishTour()
      args.schedule(() => {
        args.openClientHostedBrowserSettings()
      })
  }
}
