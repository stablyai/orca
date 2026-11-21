import { useAppStore } from '@/store'
import { MODAL_DISMISSED_KEY } from '@/store/slices/ui/modal-slot-dismissal'
import { normalizePerforceSettings } from '../../../shared/perforce/perforce-settings'

type PendingPrompt = {
  key: string
  answer: (open: boolean) => void
  decision: Promise<boolean>
  /** Set once "Always open for edit" is saving: the answer waits for the setting, not the dialog. */
  savingPreference?: true
}

let pending: PendingPrompt | null = null

/**
 * Asks in an in-app dialog whether to open a read-only Perforce file for edit before saving it.
 * A second save of the same file while the dialog is up waits on the same answer; `workspace`
 * identifies the file's workspace and host, since the same relative path in another one is another file.
 */
export function askToOpenForEdit(relativePath: string, workspace: string): Promise<boolean> {
  const key = JSON.stringify([workspace, relativePath])
  if (pending?.key === key) {
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
  const current: PendingPrompt = { key, answer, decision }
  useAppStore.getState().openModal('perforce-open-for-edit', {
    path: relativePath,
    // Why: another modal taking the slot must not leave the save waiting forever.
    [MODAL_DISMISSED_KEY]: () => {
      if (!current.savingPreference) {
        current.answer(false)
      }
    }
  })
  pending = current
  return decision
}

/** The dialog's answer to the prompt on screen. */
export function answerOpenForEditPrompt(open: boolean): void {
  pending?.answer(open)
}

/**
 * "Always open for edit": opens this file, and later saves open theirs without asking. When the
 * setting cannot be saved the file is not opened either, and the error is rethrown.
 */
export async function alwaysOpenForEdit(): Promise<void> {
  const prompt = pending
  if (prompt) {
    prompt.savingPreference = true
  }
  const { settings, updateSettingsOrThrow } = useAppStore.getState()
  try {
    await updateSettingsOrThrow({
      perforce: { ...normalizePerforceSettings(settings?.perforce), saveReadOnlyBehavior: 'auto' }
    })
  } catch (error) {
    prompt?.answer(false)
    throw error
  }
  prompt?.answer(true)
}
