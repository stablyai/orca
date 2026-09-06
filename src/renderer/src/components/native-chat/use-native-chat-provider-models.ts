import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { detectAgentSessionContinuationAgents } from '@/lib/launch-agent-session-continuation'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import {
  isNativeChatSupportedAgent,
  nativeChatRequiresLocalTranscript
} from '../../../../shared/native-chat-agent-support'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import type { AgentType } from '../../../../shared/agent-status-types'
import {
  STRUCTURED_SWITCHABLE_AGENTS,
  parseStructuredModelChoice,
  withSwitchableStructuredModels,
  type StructuredSwitchableAgent
} from '../../../../shared/structured-agent-session-switchable-models'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'
import type { NativeChatPtySessionOptionsSurface } from './native-chat-pty-session-options'
import { findTerminalTabWorktreeId } from './native-chat-file-link'

export type NativeChatSwitchProvider = (
  agent: StructuredSwitchableAgent,
  model: string
) => Promise<string | void>

export function useNativeChatProviderModels(args: {
  agent: AgentType
  terminalTabId: string
  surface: NativeChatPtySessionOptionsSurface | null
  snapshot: SessionOptionDescriptor[]
  onSwitchProvider?: NativeChatSwitchProvider
}) {
  const {
    agent: currentAgent,
    terminalTabId,
    surface: originalSurface,
    snapshot: originalSnapshot,
    onSwitchProvider
  } = args
  const worktreeId = useAppStore((state) =>
    findTerminalTabWorktreeId(state.tabsByWorktree ?? {}, terminalTabId)
  )
  const disabledAgents = useAppStore((state) => state.settings?.disabledTuiAgents)
  const canSwitch = Boolean(onSwitchProvider)
  const [detected, setDetected] = useState<{ worktreeId: string; agents: string[] } | null>(null)
  useEffect(() => {
    if (!worktreeId || !canSwitch) {
      return
    }
    let cancelled = false
    void detectAgentSessionContinuationAgents(worktreeId).then(
      (agents) => {
        if (!cancelled) {
          setDetected({ worktreeId, agents })
        }
      },
      () => {
        if (!cancelled) {
          setDetected({ worktreeId, agents: [] })
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [worktreeId, canSwitch])
  return useMemo(() => {
    if (!STRUCTURED_SWITCHABLE_AGENTS.some((agent) => agent === currentAgent) || !originalSurface) {
      return { surface: originalSurface, snapshot: originalSnapshot }
    }
    const supportedByAgent = Object.fromEntries(
      STRUCTURED_SWITCHABLE_AGENTS.map((agent) => [
        agent,
        Boolean(
          onSwitchProvider &&
          isNativeChatSupportedAgent(agent) &&
          (!nativeChatRequiresLocalTranscript(agent) ||
            isNativeChatTranscriptLocalReadable(
              getConnectionIdFromState(useAppStore.getState(), worktreeId)
            )) &&
          detected?.worktreeId === worktreeId &&
          detected.agents.includes(agent) &&
          isTuiAgentEnabled(agent, disabledAgents)
        )
      ])
    )
    const decorate = (snapshot: SessionOptionDescriptor[]) =>
      withSwitchableStructuredModels(snapshot, {
        currentAgent: currentAgent,
        live: null,
        supportedByAgent
      })
    const original = originalSurface
    let sourceSnapshot = originalSnapshot
    let snapshot = decorate(sourceSnapshot)
    const getSnapshot = () => {
      const current = original.getSnapshot()
      if (current !== sourceSnapshot) {
        sourceSnapshot = current
        snapshot = decorate(current)
      }
      return snapshot
    }
    const surface: NativeChatPtySessionOptionsSurface = {
      ...original,
      getSnapshot,
      subscribe: (listener) => original.subscribe(() => listener(getSnapshot())),
      setOption: async (id, value) => {
        const selection =
          id === 'model' && typeof value === 'string' ? parseStructuredModelChoice(value) : null
        if (selection && selection.agent !== currentAgent) {
          if (!supportedByAgent[selection.agent] || !onSwitchProvider) {
            throw new Error('This provider is not available on this workspace host.')
          }
          await onSwitchProvider(selection.agent, selection.modelId)
          return { snapshot }
        }
        await original.setOption(id, selection?.modelId ?? value)
        return { snapshot: getSnapshot() }
      }
    }
    return { surface, snapshot }
  }, [
    currentAgent,
    originalSurface,
    originalSnapshot,
    onSwitchProvider,
    detected,
    disabledAgents,
    worktreeId
  ])
}
