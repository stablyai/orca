import { useAppStore } from '@/store'

export function recordFireAndForgetInterruptInput(cacheKey: string): void {
  // AskUserQuestion dismissal is an answer, not an interrupt.
  if (useAppStore.getState().agentStatusByPaneKey[cacheKey]?.state !== 'working') {
    return
  }
  const recording = window.api.agentStatus.recordInterruptInputWritten?.(cacheKey)
  if (recording) {
    void recording.catch((error) => {
      console.warn('[agent-interrupt] fire-and-forget input recording failed:', error)
    })
  }
}
