import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { translate } from '@/i18n/i18n'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { NativeChatSubagentRun } from './NativeChatSubagentRun'
import { useNativeChatSessionChildren } from './use-native-chat-session-children'
import {
  NativeChatChildNavigationContext,
  useNativeChatChildNavigation,
  type NativeChatChildLocation
} from './native-chat-child-navigation'
import type { OrchestrationSessionChild } from '../../../../shared/orchestration-session-children'
import { subagentStateLabel } from '../../../../shared/native-chat/transcript/native-chat-subagent-group-header'
import { sayNativeChatSubagentGroupTranslated as say } from './native-chat-subagent-group-words-text'
import { NativeChatChildMetadata } from './NativeChatChildMetadata'

export function nativeChatWorkerStateLabel(worker: OrchestrationSessionChild): string {
  return worker.workerState === 'starting'
    ? translate('components.native-chat.children.starting', 'Starting')
    : subagentStateLabel(worker.state, 1, 1, say)
}

export function NativeChatSessionChildren({
  sessionId,
  target,
  dispatchId,
  isVisible
}: {
  sessionId: string
  target: RuntimeClientTarget
  dispatchId?: string
  isVisible: boolean
}): React.JSX.Element | null {
  useTranslation()
  const { children, current } = useNativeChatSessionChildren({
    sessionId,
    target,
    dispatchId,
    enabled: isVisible
  })
  const navigation = useNativeChatChildNavigation()
  const agents = useMemo(
    () =>
      children.map((child) => ({
        id: `dispatch:${child.dispatchId}`,
        label: child.label,
        state: !current && child.state === 'working' ? ('unverifiable' as const) : child.state,
        startedAt: child.startedAt,
        ...(child.settledAt === undefined ? {} : { settledAt: child.settledAt })
      })),
    [children, current]
  )
  const workerNavigation = useMemo(
    () => ({
      open: (location: NativeChatChildLocation) => {
        const child = children.find((row) => `dispatch:${row.dispatchId}` === location.agentId)
        if (child) {
          navigation?.open({
            ...location,
            source: {
              kind: 'worker',
              target,
              parentSessionId: sessionId,
              dispatchId: child.dispatchId,
              ...(dispatchId ? { parentDispatchId: dispatchId } : {})
            }
          })
        }
      }
    }),
    [children, dispatchId, navigation, sessionId, target]
  )
  if (agents.length === 0) {
    return null
  }
  return (
    <div
      data-native-chat-session-children="true"
      className="max-h-[30%] shrink-0 overflow-y-auto px-3 py-2 scrollbar-sleek sm:px-4"
    >
      <div className="mx-auto w-full max-w-(--chat-content-max-width)">
        <NativeChatChildNavigationContext.Provider value={workerNavigation}>
          <NativeChatSubagentRun
            block={{ type: 'subagent-group', groupId: `session-workers:${sessionId}`, agents }}
            entryDetails={
              new Map(
                children.map((child) => [
                  `dispatch:${child.dispatchId}`,
                  child.metadata?.agent ||
                  child.metadata?.executionHost ||
                  child.conversation.kind === 'journal' ? (
                    <NativeChatChildMetadata
                      key={child.dispatchId}
                      worker={child}
                      target={target}
                    />
                  ) : null
                ])
              )
            }
            stateLabels={
              new Map(
                children.map((child) => [
                  `dispatch:${child.dispatchId}`,
                  current
                    ? nativeChatWorkerStateLabel(child)
                    : translate('components.native-chat.children.unavailableState', 'Unavailable')
                ])
              )
            }
          />
        </NativeChatChildNavigationContext.Provider>
        {!current ? (
          <p className="text-xs text-chat-foreground-faint">
            {translate(
              'components.native-chat.children.workersUnavailable',
              'This host’s worker history is unavailable.'
            )}
          </p>
        ) : null}
      </div>
    </div>
  )
}
