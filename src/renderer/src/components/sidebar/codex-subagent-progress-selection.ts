import { useAppStore } from '@/store'
import { parseCodexSubagentProgressTarget } from './codex-subagent-progress-target'

export function resolveCodexSubagentProgressPaneKey(
  activeModal: string,
  modalData: Record<string, unknown>,
  worktreeId: string
): string | null {
  if (activeModal !== 'codex-subagent-progress') {
    return null
  }
  const target = parseCodexSubagentProgressTarget(modalData)
  return target?.worktreeId === worktreeId ? target.paneKey : null
}

export function useCodexSubagentProgressPaneKey(worktreeId: string): string | null {
  const activeModal = useAppStore((state) => state.activeModal)
  const modalData = useAppStore((state) => state.modalData)
  return resolveCodexSubagentProgressPaneKey(activeModal, modalData, worktreeId)
}
