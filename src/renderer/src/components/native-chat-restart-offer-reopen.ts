import { useAppStore } from '../store'
import { runtimeHostConnectionStateForEntry } from '@/runtime/runtime-host-connection-state'
import { requestNativeChatResumeOnRestartDialog } from './native-chat-resume-on-restart-dialog'
import { restartMachineTarget, type RestartMachineKey } from './native-chat-restart-machines'
import {
  getNativeChatRestartOffers,
  readNativeChatRestartMachine
} from './native-chat-resume-on-restart-store'
import { getNativeChatRestartResuming, getNativeChatRestartRuns } from './native-chat-restart-runs'

/** The machine to open the dialog on: the only one named, or none in particular. */
function focusOf(machines: readonly RestartMachineKey[]): RestartMachineKey | null {
  return machines.length === 1 ? machines[0]! : null
}

/** How long a click waits on a server's re-read before the dialog opens on its last listing. A
 *  connected server lists its offers in well under this (one capability probe at most, then a
 *  capsule read); past it the click must still feel answered, and the late answer lands in the
 *  open dialog like any other read. */
const PAIRED_READ_WAIT_MS = 1_500

/** Only a server whose runtime answers right now is worth a wait; any other state (its runtime not
 *  answering, contact lost or still being checked) opens on its last listing at once. */
function readableNow(machine: RestartMachineKey): boolean {
  const target = restartMachineTarget(machine)
  if (target.kind === 'local') {
    return true
  }
  const entry = useAppStore.getState().runtimeStatusByEnvironmentId.get(target.environmentId)
  return runtimeHostConnectionStateForEntry(entry) === 'connected'
}

/** This computer's read is awaited as main's opener does; a server's only for its budget. */
async function readForClick(machine: RestartMachineKey): Promise<void> {
  const target = restartMachineTarget(machine)
  const read = readNativeChatRestartMachine(target)
  if (target.kind === 'local') {
    await read
    return
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, PAIRED_READ_WAIT_MS)
  })
  await Promise.race([read, budget])
  clearTimeout(timer)
}

/**
 * Every way back to the dialog — the status bar entry, a resume toast's Show, a reconnect toast's
 * Show chats — re-reads the named machines (by default every listed one), then opens only over
 * rows, since the dialog draws nothing without them. A failed read keeps that machine's last
 * listing, so a user's click is never lost to bookkeeping. Opening a chat from it is read-only and
 * keeps the offer.
 */
export async function reopenNativeChatRestartOffer(
  machines: readonly RestartMachineKey[] = [...getNativeChatRestartOffers().keys()]
): Promise<void> {
  // Mid-resume the host's answer is already on its way; a re-read racing it could undo it.
  if (getNativeChatRestartResuming().size === 0) {
    await Promise.all(machines.filter(readableNow).map(readForClick))
  }
  // Only over rows or a run to follow: a dialog with neither draws nothing, and a request nothing
  // draws would stay open unseen.
  if (getNativeChatRestartOffers().size > 0 || getNativeChatRestartRuns().size > 0) {
    requestNativeChatResumeOnRestartDialog(focusOf(machines))
  }
}
