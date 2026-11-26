import type { StateCreator } from 'zustand'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import { isStructuredAgentId } from '../../../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import type { AppState } from '../../../types'
import { replaceTabBuckets } from '../../../record-transitions/keyed-record-transitions'
import { withStructuredChatSleptAt } from './structured-chat-slept-at'
import {
  withoutStructuredSessionLaunchDirectory,
  withStructuredSessionLaunchDirectory
} from './structured-session-launch-directories'

/** A status projection's saved provider, sleep and launch-directory facts, applied in order. */
type StructuredChatProviderWrite = {
  kind: 'provider'
  worktreeId: string
  tabId: string
  sessionId: string
  agent: string
}

export type StructuredChatCompanionWrite =
  | { kind: 'slept-at'; paneKey: string; sleptAt: number | null | undefined }
  | StructuredChatProviderWrite
  | { kind: 'launch-directory'; tabId: string; sessionId: string; launchDirectory: string }
  | { kind: 'clear-launch-directory'; tabId: string; sessionId: string }

export function structuredChatProviderWrite(
  tab: Pick<Tab, 'id' | 'entityId' | 'worktreeId' | 'agentSessionAgent'>,
  agent: string | undefined
): StructuredChatProviderWrite | null {
  return agent !== tab.agentSessionAgent && isStructuredAgentId(agent)
    ? {
        kind: 'provider',
        worktreeId: tab.worktreeId,
        tabId: tab.id,
        sessionId: tab.entityId,
        agent
      }
    : null
}

export type StructuredChatCompanionWritesSlice = {
  /** One store write per projection, so a reconnect snapshot does not notify once per chat. */
  applyStructuredChatCompanionWrites: (writes: readonly StructuredChatCompanionWrite[]) => void
}

export const createStructuredChatCompanionWritesSlice: StateCreator<
  AppState,
  [],
  [],
  StructuredChatCompanionWritesSlice
> = (set) => ({
  applyStructuredChatCompanionWrites: (writes) => {
    if (!writes.length) {
      return
    }
    set((state) => {
      let sleptAt = state.structuredChatSleptAtByPaneKey
      let directories = state.structuredSessionLaunchDirectoryByTabId
      const byWorkspace = new Map<string, Map<string, StructuredChatProviderWrite>>()
      for (const write of writes) {
        if (write.kind === 'slept-at') {
          sleptAt = withStructuredChatSleptAt(sleptAt, write.paneKey, write.sleptAt)
        } else if (write.kind === 'provider') {
          let bucket = byWorkspace.get(write.worktreeId)
          if (!bucket) {
            bucket = new Map()
            byWorkspace.set(write.worktreeId, bucket)
          }
          bucket.set(write.tabId, write)
        } else if (write.kind === 'launch-directory') {
          directories = withStructuredSessionLaunchDirectory(
            directories,
            write.tabId,
            write.sessionId,
            write.launchDirectory
          )
        } else {
          directories = withoutStructuredSessionLaunchDirectory(
            directories,
            write.tabId,
            write.sessionId
          )
        }
      }
      const replacements: [string, Tab[]][] = []
      for (const [worktreeId, changes] of byWorkspace) {
        const tabs = state.unifiedTabsByWorktree[worktreeId]
        let changed = false
        const updated = tabs?.map((tab) => {
          const write = changes.get(tab.id)
          if (
            !write ||
            tab.contentType !== 'agent-session' ||
            tab.entityId !== write.sessionId ||
            tab.agentSessionAgent === write.agent
          ) {
            return tab
          }
          changed = true
          return { ...tab, agentSessionAgent: write.agent }
        })
        if (changed && updated) {
          replacements.push([worktreeId, updated])
        }
      }
      const unifiedTabs = replacements.length
        ? replaceTabBuckets(state.unifiedTabsByWorktree, replacements)
        : state.unifiedTabsByWorktree
      if (
        sleptAt === state.structuredChatSleptAtByPaneKey &&
        directories === state.structuredSessionLaunchDirectoryByTabId &&
        unifiedTabs === state.unifiedTabsByWorktree
      ) {
        return state
      }
      return {
        ...(unifiedTabs !== state.unifiedTabsByWorktree
          ? { unifiedTabsByWorktree: unifiedTabs }
          : {}),
        ...(sleptAt !== state.structuredChatSleptAtByPaneKey
          ? { structuredChatSleptAtByPaneKey: sleptAt }
          : {}),
        ...(directories !== state.structuredSessionLaunchDirectoryByTabId
          ? { structuredSessionLaunchDirectoryByTabId: directories }
          : {})
      }
    })
  }
})
