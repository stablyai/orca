import { useMemo } from 'react'
import { SquareTerminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { structuredAgentSessionOwnerInputs } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { useTranslate } from '@/i18n/use-translate'
import { AI_VAULT_AGENTS } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import {
  runNativeChatCliFork,
  useNativeChatCliForkPending
} from '../../../tab-bar/session-actions/native-chat-cli-fork-run'
import {
  resolveTabSessionHistorySubject,
  resolveNativeChatCliForkIdentity,
  type NativeChatCliForkIdentity,
  type NativeChatTabSession
} from '../../../tab-bar/session-actions/tab-session-history-switch'

function createExecutionHostSelector(
  tabId: string,
  worktreeId: string,
  sessionId: string,
  agent: NativeChatTabSession['agent']
) {
  let inputs: unknown[] = []
  let scope: NativeChatCliForkIdentity['executionHostScope'] | null = null
  return (state: AppState) => {
    const next = [
      state.unifiedTabsByWorktree[worktreeId],
      state.floatingWorkspacePath,
      ...structuredAgentSessionOwnerInputs(state)
    ]
    if (next.some((value, index) => !Object.is(value, inputs[index]))) {
      scope =
        resolveNativeChatCliForkIdentity(state, {
          tab: { id: tabId, worktreeId },
          nativeChat: { sessionId, agent }
        })?.executionHostScope ?? null
      inputs = next
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
  const t = useTranslate()
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
  const agent = AI_VAULT_AGENTS.find((candidate) => candidate === nativeChat.agent)
  const label = t(
    'components.tab.bar.SortableTabContextMenu.switchToTerminalView',
    'Continue in terminal'
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
              void runNativeChatCliFork({ subject, tab, agent })
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
