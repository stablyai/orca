import { vi } from 'vitest'
import { UI_STORAGE_KEY } from '@/web/preload-api/web-storage'
import type { RuntimeMobileSessionAgentTab } from '../../../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import type { PersistedUIState } from '../../../../../../shared/orca-profiles/persisted-ui-state-types'
import { createUIStore, makePersistedUI } from '../../ui/ui-slice-test-harness'
import { AcceptedAgentStatuses } from '../status-ownership/accepted-agent-statuses'
import { createWebChatReadMarkReceiptBatch } from './chat-read-mark-web-move'

const LEAF = '5d906140-8048-412d-a539-25aed45333a1'
export const OLD = `agent-chat-tab-v1-abc:${LEAF}`
export const CHAT = `structured-agent-session-session-2:${LEAF}`
export const TAB: RuntimeMobileSessionAgentTab = {
  type: 'agent-session',
  id: 'agent-chat-tab-v1-abc',
  sessionId: 'session-2',
  title: 'Chat',
  agent: 'codex',
  isActive: true
}

export function browserChatMarks(initial: Partial<PersistedUIState>) {
  let json = JSON.stringify(initial)
  const localStorage = {
    getItem: vi.fn((key: string) => (key === UI_STORAGE_KEY ? json : null)),
    setItem: vi.fn((_key: string, value: string) => {
      json = value
    })
  }
  vi.stubGlobal('window', {
    __ORCA_WEB_CLIENT__: true,
    api: { ui: { set: vi.fn().mockResolvedValue(undefined) } },
    localStorage
  })
  const stored = (): Partial<PersistedUIState> => JSON.parse(json)
  const open = (snapshot = stored(), liveTurn?: number) => {
    const store = createUIStore()
    const statuses = new AcceptedAgentStatuses()
    const agentStatusByPaneKey =
      liveTurn === undefined
        ? statuses
        : statuses.replace([
            [
              CHAT,
              {
                paneKey: CHAT,
                state: 'done',
                prompt: '',
                stateStartedAt: liveTurn,
                updatedAt: liveTurn,
                stateHistory: []
              }
            ]
          ])
    store.setState({ agentStatusByPaneKey })
    store.getState().hydratePersistedUI(makePersistedUI(snapshot), 'startup')
    const receive = (tabs: readonly RuntimeMobileSessionAgentTab[]) => {
      const batch = createWebChatReadMarkReceiptBatch()
      batch?.collect(tabs)
      const moved = batch?.move(store.getState())
      if (moved) {
        store.setState(moved)
      }
    }
    return { store, receive }
  }
  return {
    localStorage,
    stored,
    open,
    replaceStored: (raw: string) => {
      json = raw
    }
  }
}
