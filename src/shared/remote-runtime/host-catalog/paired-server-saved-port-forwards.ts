import { z } from 'zod'
import type { SavedPortForward } from '../ssh/ssh-types'
import { loopbackPortForwardDialHost } from '../../workspace/ports/port-forward-loopback-host'

/** A paired server's forwards, restored when it reconnects. */
export type PairedServerSavedPortForwards = {
  /** Digest of the host key they were made for; another machine paired under the same entry restores none. */
  hostKeyFingerprint: string
  forwards: SavedPortForward[]
}

const Port = z.number().int().min(1).max(65_535)
const SavedForward = z.object({
  localPort: Port,
  remoteHost: z.string().max(256),
  remotePort: Port,
  label: z.string().max(256).optional()
})
const SavedRecord = z.object({
  hostKeyFingerprint: z.string().min(1).max(128),
  forwards: z.array(z.unknown())
})

/** Null for a record this build can't read; forwards off the server's loopback are dropped. */
export function readPairedServerSavedPortForwards(
  raw: unknown
): PairedServerSavedPortForwards | null {
  const record = SavedRecord.safeParse(raw)
  if (!record.success) {
    return null
  }
  const forwards: SavedPortForward[] = []
  for (const candidate of record.data.forwards) {
    const forward = SavedForward.safeParse(candidate)
    const remoteHost = forward.success ? loopbackPortForwardDialHost(forward.data.remoteHost) : null
    if (forward.success && remoteHost) {
      forwards.push({ ...forward.data, remoteHost })
    }
  }
  return { hostKeyFingerprint: record.data.hostKeyFingerprint, forwards }
}
