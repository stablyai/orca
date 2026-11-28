import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { emulatorRuntimeTarget } from '@/lib/simulator/runtime/emulator-runtime-target'

/** Committed or pasted text, typed by the host that runs the workspace's simulator. */
export async function typeEmulatorText(
  worktreeId: string,
  text: string,
  paste = false
): Promise<unknown> {
  return callRuntimeRpc(emulatorRuntimeTarget(worktreeId), 'emulator.type', {
    ...(paste ? { paste: true } : {}),
    text,
    worktree: worktreeId
  })
}

export type SimulatorKeyboardLayout = { physicalKeys: boolean; printableAsText: boolean }

/** Puts this desktop's simulator on the Mac's layout, so physical keys type what they show. A paired
 *  server's simulator is left alone: the sync would apply that Mac's layout, not this keyboard's,
 *  so its printable keys go as typed text. */
export async function syncSimulatorKeyboardLayout(
  worktreeId: string
): Promise<SimulatorKeyboardLayout> {
  const target = emulatorRuntimeTarget(worktreeId)
  if (target.kind !== 'local') {
    return { physicalKeys: false, printableAsText: true }
  }
  const result = await callRuntimeRpc<{ physicalKeys: boolean }>(
    target,
    'emulator.syncKeyboardLayout',
    { worktree: worktreeId }
  )
  return { physicalKeys: result.physicalKeys === true, printableAsText: false }
}
