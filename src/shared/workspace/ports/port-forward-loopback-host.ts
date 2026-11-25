import { z } from 'zod'

export type LoopbackPortForwardDialHost = 'localhost' | '127.0.0.1' | '::1'

const DIAL_HOSTS: ReadonlyMap<string, LoopbackPortForwardDialHost> = new Map([
  ['localhost', 'localhost'],
  ['127.0.0.1', '127.0.0.1'],
  ['::1', '::1'],
  ['[::1]', '::1']
])

/** The loopback host a forward may dial on the remote machine; null for anything off its own loopback. */
export function loopbackPortForwardDialHost(host: string): LoopbackPortForwardDialHost | null {
  return DIAL_HOSTS.get(host.trim().toLowerCase()) ?? null
}

export function requireLoopbackPortForwardDialHost(host: string): LoopbackPortForwardDialHost {
  const dialHost = loopbackPortForwardDialHost(host)
  if (!dialHost) {
    throw new Error('Only localhost ports on a paired server can be forwarded.')
  }
  return dialHost
}

// The attach names no destination: each stream's Open frame does, and the host checks it.
export const NetworkPortForwardAttachParams = z.object({}).strict()
