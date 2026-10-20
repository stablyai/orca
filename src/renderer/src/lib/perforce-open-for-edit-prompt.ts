import { useAppStore } from '@/store'
import { MODAL_DISMISSED_KEY } from '@/store/slices/modal-slot-dismissal'
import { normalizePerforceSettings } from '../../../shared/perforce/perforce-settings'

let pending: { path: string; answer: (open: boolean) => void; decision: Promise<boolean> } | null =
  null

/**
 * Asks in an in-app dialog whether to open a read-only Perforce file for edit before saving it.
 * A second save of the same file while the dialog is up waits on the same answer.
 */
export function askToOpenForEdit(relativePath: string): Promise<boolean> {
  if (pending?.path === relativePath) {
    return pending.decision
  }
  let answer: (open: boolean) => void = () => {}
  const decision = new Promise<boolean>((resolve) => {
    let settled = false
    answer = (open) => {
      if (settled) {
        return
      }
      settled = true
      if (pending?.answer === answer) {
        pending = null
      }
      resolve(open)
    }
  })
  const current = { path: relativePath, answer, decision }
  useAppStore.getState().openModal('perforce-open-for-edit', {
    path: relativePath,
    // Why: another modal taking the slot must not leave the save waiting forever.
    [MODAL_DISMISSED_KEY]: () => current.answer(false)
  })
  pending = current
  return decision
}

/** The dialog's answer to the prompt on screen. */
export function answerOpenForEditPrompt(open: boolean): void {
  pending?.answer(open)
}

/** "Always open for edit": opens this file, and later saves open theirs without asking. */
export function alwaysOpenForEdit(): void {
  const { settings, updateSettings } = useAppStore.getState()
  void updateSettings({
    perforce: { ...normalizePerforceSettings(settings?.perforce), saveReadOnlyBehavior: 'auto' }
  })
  answerOpenForEditPrompt(true)
}
