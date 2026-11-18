import { create } from 'zustand'
import type { HistoryResumePlan } from '../../../../../../shared/ai-vault/resume/history-resume-accounts'

export const useHistoryResumeChoice = create<{
  request: {
    plan: HistoryResumePlan
    settle: (accountId: string | null | undefined) => void
  } | null
}>(() => ({ request: null }))

export function chooseHistoryResumeAccount(
  plan: HistoryResumePlan
): Promise<string | null | undefined> {
  useHistoryResumeChoice.getState().request?.settle(undefined)
  return new Promise((resolve) => {
    useHistoryResumeChoice.setState({
      request: {
        plan,
        settle: (value) => {
          useHistoryResumeChoice.setState({ request: null })
          resolve(value)
        }
      }
    })
  })
}
