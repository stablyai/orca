import { useAppStore } from '@/store/index'
import { confirmRuntimeTerminalForegroundProcess } from '@/runtime/hosted-terminals/inspection/runtime-terminal-process-inspection'
import {
  foregroundIsLiveClaude,
  type LiveClaudeEvidence
} from '@/lib/agent-status/evidence/prompt-cache-request-evidence'
import { recognizeAgentProcess } from '../../../../../../shared/agent-status/process/agent-process-recognition'
import {
  createRestoredPromptCacheTimer,
  type RestoredPromptCacheTimer
} from '../../titles/restored-prompt-cache-timer'

export function createParkedRestoredPromptCacheTimer(args: {
  paneKey: string
  ptyId: string
  allowInitialIdleSeed: boolean
  isDisposed: () => boolean
}): RestoredPromptCacheTimer {
  const { paneKey } = args
  let liveClaude: LiveClaudeEvidence = 'unread'
  let processReadStarted = false
  const timer = createRestoredPromptCacheTimer({
    paneKey,
    allowInitialIdleSeed: () => args.allowInitialIdleSeed,
    liveClaude: () =>
      liveClaude !== 'unread'
        ? liveClaude
        : foregroundIsLiveClaude(useAppStore.getState().paneForegroundAgentByPaneKey[paneKey]),
    requestProcessRead: () => {
      if (processReadStarted) {
        return
      }
      processReadStarted = true
      void confirmRuntimeTerminalForegroundProcess(args.ptyId).then((processName) => {
        if (!args.isDisposed() && processName !== null) {
          liveClaude = recognizeAgentProcess(processName)?.agent === 'claude'
          timer.retry()
        }
      })
    },
    setCacheTimerStartedAt: (key, entry) =>
      useAppStore.getState().setCacheTimerStartedAt(key, entry)
  })
  return timer
}
