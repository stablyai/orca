import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AppState } from '@/store/types'
import type { Tab } from '../../../shared/tab-types'
import { normalizeAgentSessionConversationName } from '../../../shared/agent-session/agent-session-conversation-name'
import { callRuntimeRpc } from './runtime-rpc-client'
import { supportsStructuredAgentSessionRename } from './structured-agent-session-client'
import {
  structuredAgentSessionTargetForHost,
  structuredAgentSessionOwnerForTab,
  legacyStructuredChatRenameOwner,
  executionHostIdForStructuredTarget
} from './structured-agent-session-owner'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { sendTabChangeToLayoutOwner } from '@/store/terminals/tab-change-through-layout-owner'
import { captureStructuredChatRename } from './structured-chat-rename-action'

type RenameResult = { name: string | null; applied: boolean }

/**
 * Names a chat on the host that owns it: the one name Session History, tabs, sidebars and phones
 * read, so it outlives the tab. A host too old to store it keeps the name on this window's tab, as
 * before names were saved there.
 */
export async function renameStructuredChatTab(
  get: () => AppState,
  tab: Tab,
  title: string | null,
  opts: { recordInteraction?: boolean } | undefined,
  keepOnTab: () => void,
  action = captureStructuredChatRename(get, tab)
): Promise<void> {
  try {
    await submitRename(get, tab, title, opts, keepOnTab, action)
  } finally {
    action.finish()
  }
}

async function submitRename(
  get: () => AppState,
  tab: Tab,
  title: string | null,
  opts: { recordInteraction?: boolean } | undefined,
  keepOnTab: () => void,
  action: ReturnType<typeof captureStructuredChatRename>
): Promise<void> {
  if (!action.current()) {
    return
  }
  const { target } = action
  if (!target || !(await supportsStructuredAgentSessionRename(target))) {
    if (action.aliasCurrent()) {
      keepOnTab()
    }
    return
  }
  if (!action.current()) {
    return
  }
  const name = normalizeAgentSessionConversationName(title)
  if (name === null) {
    // Clearing would leave the chat with no name for good: naming runs once, on the first message.
    toast.error(translate('components.tab.bar.chatRename.empty', "A chat name can't be empty"))
    return
  }
  if (opts?.recordInteraction !== false) {
    get().recordFeatureInteraction?.('terminal-tabs')
  }
  try {
    await callRuntimeRpc<RenameResult>(target, 'agentSession.rename', {
      sessionId: tab.entityId,
      name
    })
  } catch (error) {
    console.warn('[structured-chat-rename] rename failed', error)
    if (action.current()) {
      toast.error(translate('components.tab.bar.chatRename.failed', "Couldn't rename this chat"))
    }
    return
  }
  if (!action.current()) {
    return
  }
  if (action.retainAlias) {
    if (action.aliasCurrent()) {
      get().setTabCustomLabel(tab.id, name, { recordInteraction: false })
    }
    return
  }
  await dropLegacyAlias(
    get,
    tab,
    tab.customLabel ?? null,
    executionHostIdForStructuredTarget(target),
    structuredAgentSessionOwnerForTab,
    action.current
  )
}

/**
 * Uploads a tab rename this window saved before names lived on the host. The host takes it only
 * while the chat still has Orca's own name, so a later rename from any window wins; either way the
 * host's name is the chat's name from then on and the tab stops carrying its own.
 */
export async function uploadLegacyStructuredChatRename(
  get: () => AppState,
  tab: Tab,
  alias: string,
  name: string
): Promise<boolean> {
  const target = structuredAgentSessionTargetForHost(legacyStructuredChatRenameOwner(get(), tab))
  if (!target || !(await supportsStructuredAgentSessionRename(target))) {
    return false
  }
  try {
    await callRuntimeRpc<RenameResult>(target, 'agentSession.rename', {
      sessionId: tab.entityId,
      name,
      legacyAlias: true
    })
  } catch (error) {
    console.warn('[structured-chat-rename] legacy rename upload failed', error)
    return false
  }
  return dropLegacyAlias(
    get,
    tab,
    alias,
    executionHostIdForStructuredTarget(target),
    legacyStructuredChatRenameOwner
  )
}

/** Clears the tab's own name only if it is still the one the host just answered for. */
async function dropLegacyAlias(
  get: () => AppState,
  tab: Tab,
  alias: string | null,
  owner: string,
  ownerForTab = structuredAgentSessionOwnerForTab,
  isCurrent = () => true
): Promise<boolean> {
  if (alias === null) {
    return true
  }
  const state = get()
  const matches = () => {
    const latest = get()
    const current = latest.unifiedTabsByWorktree[tab.worktreeId]?.find(
      (entry) => entry.id === tab.id
    )
    return (
      isCurrent() &&
      current?.contentType === 'agent-session' &&
      current.entityId === tab.entityId &&
      current.customLabel === alias &&
      ownerForTab(latest, current) === owner
    )
  }
  if (!matches()) {
    return true
  }
  const clear = () => {
    if (matches()) {
      get().setTabCustomLabel(tab.id, null, { recordInteraction: false })
    }
  }
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    clear()
    return true
  }
  return new Promise((resolve) => {
    if (
      !sendTabChangeToLayoutOwner(
        state,
        tab,
        (id) => ({
          type: 'renameTab',
          tabId: id,
          kind: 'custom',
          title: null,
          expected: { entityId: tab.entityId, executionHostId: owner, customTitle: alias }
        }),
        () => {
          clear()
          resolve(true)
        },
        {
          shown: () => {
            clear()
            resolve(true)
          },
          refused: () => resolve(false)
        }
      )
    ) {
      clear()
      resolve(true)
    }
  })
}
