import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import type { AiVaultPrepareSessionResumeResult } from '../../../../../../shared/ai-vault/resume/ai-vault-resume-preparation'
import type { AiVaultSessionDragPayload } from './ai-vault-session-drag'
import { toast } from 'sonner'
import { describeAiVaultResumeFailure } from './ai-vault-resume-refusal'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'

export async function waitForHistoryTerminalOpen(tabId: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let appeared = false
    const finish = (error?: Error) => {
      unsubscribe()
      clearTimeout(timeout)
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
    const inspect = (state: AppState) => {
      if (!state.terminalLayoutsByTabId[tabId]) {
        if (appeared) {
          finish(new DOMException('Resume cancelled', 'AbortError'))
        }
        return
      }
      appeared = true
      if (state.ptyIdsByTabId[tabId]?.length) {
        finish()
      } else {
        const failure = Object.entries(state.terminalPaneStartsByPaneKey).find(
          ([key, start]) => key.startsWith(`${tabId}:`) && start.status === 'failed'
        )?.[1]
        if (failure?.status === 'failed') {
          finish(new Error(failure.reason))
        }
      }
    }
    const unsubscribe = useAppStore.subscribe(inspect)
    const timeout = setTimeout(
      () => finish(new Error('The terminal did not open. Check the terminal and try again.')),
      30_000
    )
    inspect(useAppStore.getState())
  })
}

export async function commitHistorySessionResume(
  session: Pick<
    AiVaultSession,
    'agent' | 'sessionId' | 'filePath' | 'codexHome' | 'executionHostId' | 'resumeReceipt'
  >
): Promise<void> {
  if (!session.resumeReceipt) {
    return
  }
  try {
    await window.api.aiVault.prepareSessionResume({
      agent: session.agent,
      sessionId: session.sessionId,
      filePath: session.filePath,
      codexHome: session.codexHome,
      executionHostId: session.executionHostId,
      commitToken: session.resumeReceipt
    })
    window.dispatchEvent(new Event('orca-history-continuations-changed'))
  } catch (error) {
    toast.error(
      'The terminal opened, but History could not record its account. Retry saving History.',
      {
        action: {
          label: 'Retry',
          onClick: () => {
            void commitHistorySessionResume(session)
          }
        },
        description: error instanceof Error ? error.message : String(error)
      }
    )
  }
}

export async function commitHistoryDropResume(
  payload: AiVaultSessionDragPayload,
  result: AiVaultPrepareSessionResumeResult,
  tabId?: string
) {
  if (!result.resumeReceipt) {
    return
  }
  try {
    if (!tabId) {
      throw new Error(
        'The resumed terminal could not be verified. History has not recorded an account change.'
      )
    }
    await waitForHistoryTerminalOpen(tabId)
    await commitHistorySessionResume({
      agent: payload.agent,
      sessionId: result.substituteSessionId ?? payload.sessionId,
      filePath: result.substituteTranscriptPath ?? payload.sessionFilePath ?? '',
      codexHome: result.substituteCodexHome ?? payload.codexHome ?? null,
      executionHostId: payload.sessionExecutionHostId ?? 'local',
      resumeReceipt: result.resumeReceipt
    })
  } catch (error) {
    if (!(error instanceof Error && error.name === 'AbortError')) {
      toast.error(describeAiVaultResumeFailure(error, payload.agent))
    }
  }
}
