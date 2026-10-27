import { useMemo } from 'react'
import { SquareTerminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { selectFolderWorkspaces, selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import { translate } from '@/i18n/i18n'
import { AI_VAULT_AGENTS } from '../../../../shared/ai-vault-types'
import {
  runNativeChatCliFork,
  useNativeChatCliForkPending
} from '../tab-bar/native-chat-cli-fork-run'
import {
  resolveTabSessionHistorySubject,
  resolveNativeChatCliForkIdentity,
  type NativeChatCliForkIdentity,
  type NativeChatTabSession
} from '../tab-bar/tab-session-history-switch'

function createExecutionHostSelector(
  tabId: string,
  worktreeId: string,
  sessionId: string,
  agent: NativeChatTabSession['agent']
) {
  let worktrees: AppState['worktreesByRepo'] | undefined
  let folders: AppState['folderWorkspaces'] | undefined
  let groups: AppState['projectGroups'] | undefined
  let repos: AppState['repos'] | undefined
  let scope: NativeChatCliForkIdentity['executionHostScope'] | null = null
  return (state: AppState) => {
    const nextWorktrees = selectWorktreesByRepo(state)
    const nextFolders = selectFolderWorkspaces(state)
    if (
      worktrees !== nextWorktrees ||
      folders !== nextFolders ||
      groups !== state.projectGroups ||
      repos !== state.repos
    ) {
      scope =
        resolveNativeChatCliForkIdentity(state, {
          tab: { id: tabId, worktreeId },
          nativeChat: { sessionId, agent }
        })?.executionHostScope ?? null
      worktrees = nextWorktrees
      folders = nextFolders
      groups = state.projectGroups
      repos = state.repos
    }
    return scope
  }
}

export function NativeChatResumeInCliButton({
  tabId,
  worktreeId,
  nativeChat
}: {
  tabId: string
  worktreeId: string
  nativeChat: NativeChatTabSession
}): React.JSX.Element | null {
  const tab = { id: tabId, worktreeId }
  const { sessionId, agent: nativeAgent } = nativeChat
  const selectExecutionHost = useMemo(
    () => createExecutionHostSelector(tabId, worktreeId, sessionId, nativeAgent),
    [tabId, worktreeId, sessionId, nativeAgent]
  )
  const executionHostScope = useAppStore(selectExecutionHost)
  const pending = useNativeChatCliForkPending(
    executionHostScope ? { executionHostScope, sessionId: nativeChat.sessionId } : null
  )
  const commandOverrides = useAppStore((state) => state.settings?.agentCmdOverrides)
  const agent = AI_VAULT_AGENTS.find((candidate) => candidate === nativeChat.agent)
  const label = translate(
    'components.tab.bar.SortableTabContextMenu.switchToTerminalView',
    'Continue with Terminal Agent'
  )
  if (!executionHostScope || !agent) {
    return null
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="pane-title"
          size="icon-xs"
          aria-label={label}
          disabled={pending}
          aria-busy={pending || undefined}
          onClick={(event) => {
            event.stopPropagation()
            const subject = resolveTabSessionHistorySubject(useAppStore.getState(), {
              tab,
              nativeChat
            })
            if (subject?.kind === 'chat') {
              void runNativeChatCliFork({ subject, tab, agent, commandOverrides })
            }
          }}
        >
          <SquareTerminal className="size-3" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
