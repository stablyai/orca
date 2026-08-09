import { createHash } from 'node:crypto'

export function zmxPtyNamespaceForRelaySocketName(socketName: string): string {
  return createHash('sha256').update(socketName).digest('hex').slice(0, 16)
}
