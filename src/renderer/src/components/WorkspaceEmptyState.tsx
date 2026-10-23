import { FileText, Globe, Terminal } from 'lucide-react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { getWorkspaceClientCreationActionPolicy } from '@/lib/client-creation-action-policy'
import { showClientCreationActionError } from '@/lib/client-creation-action-error'
import { openDocumentInFloatingWorkspace } from '@/lib/open-document-in-floating-workspace'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { WorkspaceEmptyAgentList } from './WorkspaceEmptyAgentList'
import { Button } from './ui/button'

export function WorkspaceEmptyState({
  worktreeId,
  groupId
}: {
  worktreeId: string
  groupId: string
}): React.JSX.Element {
  const newTerminal = useAppStore((state) => state.openNewTerminalTabInActiveWorkspace)
  const newBrowser = useAppStore((state) => state.openNewBrowserTabInActiveWorkspace)
  const openModal = useAppStore((state) => state.openModal)
  const focusGroup = useAppStore((state) => state.focusGroup)
  const browserEnabled = useAppStore(
    (state) =>
      getWorkspaceClientCreationActionPolicy(state, worktreeId)['managed-browser'].state ===
      'enabled'
  )
  const openFile = async (): Promise<void> => {
    focusGroup(worktreeId, groupId)
    if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
      const document = await window.api.app.pickFloatingMarkdownDocument()
      if (document) {
        openDocumentInFloatingWorkspace(useAppStore.getState().openFile, document, {
          targetGroupId: groupId
        })
      }
      return
    }
    openModal('quick-open')
  }

  return (
    <section className="flex h-full min-h-0 flex-1 items-center justify-center overflow-y-auto bg-background p-6 scrollbar-sleek">
      <div className="@container my-auto w-full max-w-xl py-8">
        <h2 className="text-lg font-medium text-foreground">
          {translate('components.WorkspaceEmptyState.title', 'What would you like to do?')}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {translate(
            'components.WorkspaceEmptyState.description',
            'No tabs are open here. Start an agent or open a tool to get going.'
          )}
        </p>
        <div className="mt-6 space-y-1 border-b border-border pb-4">
          <Button
            variant="ghost"
            size="lg"
            className="w-full justify-start"
            onClick={() => void openFile().catch(showClientCreationActionError)}
          >
            <FileText className="text-muted-foreground" />
            {translate('components.WorkspaceEmptyState.openFile', 'Open a file')}
          </Button>
          <Button
            variant="ghost"
            size="lg"
            className="w-full justify-start"
            onClick={() => void newTerminal(groupId).catch(showClientCreationActionError)}
          >
            <Terminal className="text-muted-foreground" />
            {translate('components.WorkspaceEmptyState.terminal', 'Open a terminal')}
          </Button>
          {browserEnabled ? (
            <Button
              variant="ghost"
              size="lg"
              className="w-full justify-start"
              onClick={() => void newBrowser(groupId).catch(showClientCreationActionError)}
            >
              <Globe className="text-muted-foreground" />
              {translate('components.WorkspaceEmptyState.browser', 'Open a browser')}
            </Button>
          ) : null}
        </div>
        <WorkspaceEmptyAgentList worktreeId={worktreeId} groupId={groupId} />
      </div>
    </section>
  )
}
