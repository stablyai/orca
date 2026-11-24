import type { PortForwardEntry } from '../../../../../shared/remote-runtime/ssh/ssh-types'

/** The connection that carries a forward: an SSH session, or a paired server's own connection. */
export type PortForwardOwner =
  | { kind: 'ssh'; targetId: string }
  | { kind: 'runtime'; environmentId: string }

/** The store key its forwards live under (portForwardsByConnection). */
export function portForwardOwnerKey(owner: PortForwardOwner): string {
  return owner.kind === 'ssh' ? owner.targetId : owner.environmentId
}

type PortForwardChange = {
  localPort: number
  remoteHost: string
  remotePort: number
  label?: string
}

export function addPortForward(
  owner: PortForwardOwner,
  change: PortForwardChange
): Promise<PortForwardEntry> {
  return owner.kind === 'ssh'
    ? window.api.ssh.addPortForward({ targetId: owner.targetId, ...change })
    : requireRuntimePortForwards().add({ environmentId: owner.environmentId, ...change })
}

export function updatePortForward(
  owner: PortForwardOwner,
  id: string,
  change: PortForwardChange
): Promise<PortForwardEntry> {
  return owner.kind === 'ssh'
    ? window.api.ssh.updatePortForward({ id, targetId: owner.targetId, ...change })
    : requireRuntimePortForwards().update({ id, environmentId: owner.environmentId, ...change })
}

export async function removePortForward(owner: PortForwardOwner, id: string): Promise<void> {
  await (owner.kind === 'ssh'
    ? window.api.ssh.removePortForward({ id })
    : requireRuntimePortForwards().remove({ id }))
}

function requireRuntimePortForwards() {
  const api = window.api.runtimeEnvironments.portForwards
  if (!api) {
    throw new Error('Port forwarding is unavailable in this client.')
  }
  return api
}
