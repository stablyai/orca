import { z } from 'zod'
import type { PtyChildProcessVerdict } from './terminal-process-inspection'

/** Opt-in full observation by the process owner, never inferred from a shell name alone. */
export type TerminalInterfaceEvidence = {
  shellForeground: boolean
  children: PtyChildProcessVerdict
  capturedAgeMs: number
}

export type TerminalInterfaceBinding = {
  ptyId: string
  incarnationId: string
  terminalHandle: string
  paneKey: string
  worktreeId: string
}

/** Runtime-only; an observation of the interface, not its latest turn or launch intent. */
export type TerminalInterfaceObservation = TerminalInterfaceBinding & {
  epoch: string
  revision: number
  inputRevision: number
  executionLaunchToken: string | null
  owner: string | null
  state: 'agent' | 'shell' | 'unverifiable'
  basis: 'process' | 'hook' | 'cold'
}

export const TERMINAL_INTERFACE_CAPABILITY = 'terminal.interface.v1'

export function terminalInterfaceObservationsEqual(
  left: TerminalInterfaceObservation | null | undefined,
  right: TerminalInterfaceObservation | null | undefined
): boolean {
  return (
    left === right ||
    (left != null &&
      right != null &&
      left.epoch === right.epoch &&
      left.revision === right.revision &&
      left.ptyId === right.ptyId &&
      left.incarnationId === right.incarnationId)
  )
}

export const terminalInterfaceSnapshotSchema = z.object({
  type: z.literal('terminalInterfaces'),
  epoch: z.string().min(1),
  revision: z.number().int().nonnegative(),
  observations: z.array(
    z.object({
      ptyId: z.string().min(1),
      incarnationId: z.string().min(1),
      terminalHandle: z.string().min(1),
      paneKey: z.string().min(1),
      worktreeId: z.string().min(1),
      epoch: z.string().min(1),
      revision: z.number().int().nonnegative(),
      inputRevision: z.number().int().nonnegative(),
      executionLaunchToken: z.string().nullable(),
      owner: z.string().nullable(),
      state: z.enum(['agent', 'shell', 'unverifiable']),
      basis: z.enum(['process', 'hook', 'cold'])
    })
  )
})
