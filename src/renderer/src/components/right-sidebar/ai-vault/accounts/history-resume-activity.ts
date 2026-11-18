import { create } from 'zustand'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
type Activity = { phase: 'preparing' | 'opening' | 'error'; message?: string }
export const useHistoryResumeActivity = create<{ entries: Record<string, Activity> }>(() => ({
  entries: {}
}))
export function historyResumeActivityKey(
  session: Pick<AiVaultSession, 'executionHostId' | 'agent' | 'sessionId'>
): string {
  return JSON.stringify([session.executionHostId, session.agent, session.sessionId])
}
export function setHistoryResumeActivity(key: string, value?: Activity) {
  useHistoryResumeActivity.setState((state) => {
    const entries = { ...state.entries }
    if (value) {
      entries[key] = value
    } else {
      delete entries[key]
    }
    return { entries }
  })
}
