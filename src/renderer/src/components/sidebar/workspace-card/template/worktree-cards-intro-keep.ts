import { useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import {
  trackWorktreeCardsIntroAction,
  trackWorktreeCardStyleChanged
} from './worktree-card-style-telemetry'

// Why module scope: the note unmounts when the sidebar collapses or switches body, but its Keep
// write keeps going; a remount must join it, not start a second one or unlock dismissal.
let pendingKeep: Promise<void> | null = null
const listeners = new Set<() => void>()

function notify(): void {
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

async function runKeep(): Promise<void> {
  const store = useAppStore.getState
  try {
    await store().updateSettingsOrThrow({ experimentalNewWorktreeCardStyle: true })
  } catch {
    toast.error(
      translate(
        'sidebar.worktreeCardsIntroNotice.saveFailedToast',
        "Couldn't save the card style. Try again."
      )
    )
    return
  }
  // Why trust only the published store: it is the settings layer's latest ordered answer. Reading
  // main or patching the store here could resurrect New over a newer Classic choice.
  if (store().settings?.experimentalNewWorktreeCardStyle === true) {
    trackWorktreeCardsIntroAction('kept', 'new')
    trackWorktreeCardStyleChanged(true, 'intro_note')
    store().setWorktreeCardsIntroKeptHintOpen(true)
    return
  }
  // A newer settings write answered or fenced this one; close quietly and let publication settle.
  store().setWorktreeCardsIntroChoice(null)
}

/** Saves the new cards once; repeat calls while a save is in flight join it. */
export function keepNewWorktreeCards(): Promise<void> {
  if (!pendingKeep) {
    pendingKeep = runKeep().finally(() => {
      pendingKeep = null
      notify()
    })
    notify()
  }
  return pendingKeep
}

export function useWorktreeCardsKeepPending(): boolean {
  return useSyncExternalStore(subscribe, () => pendingKeep !== null)
}
