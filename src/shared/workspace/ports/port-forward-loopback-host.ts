import { z } from 'zod'

export type PairedPortForwardDialHost = 'localhost' | '127.0.0.1' | '::1'

const DIAL_HOSTS: ReadonlyMap<string, PairedPortForwardDialHost> = new Map([
  ['localhost', 'localhost'],
  ['127.0.0.1', '127.0.0.1'],
  ['::1', '::1'],
  ['[::1]', '::1']
])

/** The server loopback host a paired client's forward may dial; null for anything off the server's own loopback. */
export function pairedPortForwardDialHost(host: string): PairedPortForwardDialHost | null {
  return DIAL_HOSTS.get(host.trim().toLowerCase()) ?? null
}

// The attach names no destination: each stream's Open frame does, and the host checks it.
export const NetworkPortForwardAttachParams = z.object({}).strict()
