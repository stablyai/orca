import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { shallow } from 'zustand/shallow'
import { getStructuredAgentSessionTabs } from '@/components/native-chat/structured-agent-session-tabs'
import { subscribeLocalRuntimeCapabilitiesKnown } from './local-runtime-capabilities'
import { subscribeRuntimeHostContactRegained } from './runtime-host-contact-regained'
import {
  legacyStructuredChatRenameOwner,
  structuredAgentSessionCatalogOwnerInputs,
  structuredAgentSessionTargetForHost
} from './structured-agent-session-owner'
import { uploadLegacyStructuredChatRename } from './structured-chat-rename'

/** Remaining saved aliases are the migration debt; only active requests need bookkeeping. */
export function installLegacyChatRenameMigration(): () => void {
  const inFlight = new Map<string, Promise<unknown>>()
  const contacts = new Map<string, () => void>()
  let previousCandidates = ''
  let disposed = false
  const contactRegained = () => {
    void Promise.allSettled(inFlight.values()).then(() => reconcile(true))
  }
  const reconcile = (retryPending = false) => {
    if (disposed) {
      return
    }
    const state = useAppStore.getState()
    const pending = state.workspaceSessionReady
      ? getStructuredAgentSessionTabs(state.unifiedTabsByWorktree).flatMap((tab) => {
          const alias = tab.customLabel
          const owner = legacyStructuredChatRenameOwner(state, tab)
          const target = structuredAgentSessionTargetForHost(owner)
          return alias && target
            ? [
                {
                  tab,
                  alias,
                  target,
                  key: JSON.stringify([owner, tab.worktreeId, tab.id, tab.entityId, alias])
                }
              ]
            : []
        })
      : []
    const environments = new Set(
      pending.flatMap(({ target }) => (target.kind === 'environment' ? [target.environmentId] : []))
    )
    for (const [id, stop] of contacts) {
      if (!environments.has(id)) {
        stop()
        contacts.delete(id)
      }
    }
    for (const id of environments) {
      if (!contacts.has(id)) {
        contacts.set(id, subscribeRuntimeHostContactRegained(id, contactRegained))
      }
    }
    const candidates = JSON.stringify(pending.map(({ key }) => key))
    if (!retryPending && candidates === previousCandidates) {
      return
    }
    previousCandidates = candidates
    for (const { tab, alias, key } of pending) {
      if (inFlight.has(key)) {
        continue
      }
      const request = uploadLegacyStructuredChatRename(useAppStore.getState, tab, alias)
        .catch((error: unknown) => console.warn('[structured-chat-rename] migration failed', error))
        .finally(() => inFlight.delete(key))
      inFlight.set(key, request)
    }
  }
  const stopStore = useAppStore.subscribe((state, previous) => {
    if (
      state.workspaceSessionReady !== previous.workspaceSessionReady ||
      state.unifiedTabsByWorktree !== previous.unifiedTabsByWorktree ||
      !shallow(
        structuredAgentSessionCatalogOwnerInputs(state),
        structuredAgentSessionCatalogOwnerInputs(previous)
      )
    ) {
      reconcile()
    }
  })
  const stopLocal = subscribeLocalRuntimeCapabilitiesKnown(contactRegained)
  reconcile()
  return () => {
    disposed = true
    stopStore()
    stopLocal()
    contacts.forEach((stop) => stop())
  }
}

export function useLegacyChatRenameMigration(): void {
  useEffect(() => installLegacyChatRenameMigration(), [])
}
