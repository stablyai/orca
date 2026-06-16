import type { DockerConnection } from '../../../../shared/docker-types'

export type DockerConnectionDraft = {
  label: string
  kind: 'ssh' | 'tcp'
  sshTargetId: string
  tcpHost: string
  tcpPort: string
}

export type DockerConnectionDraftError =
  | 'label_required'
  | 'ssh_target_required'
  | 'tcp_host_required'
  | 'tcp_port_required'

export type DockerConnectionDraftResult =
  | { ok: true; connection: DockerConnection }
  | { ok: false; error: DockerConnectionDraftError }

/** Validate a connection form draft into a DockerConnection. `id` is supplied by the caller. */
export function buildDockerConnectionFromDraft(
  draft: DockerConnectionDraft,
  id: string
): DockerConnectionDraftResult {
  const label = draft.label.trim()
  if (label.length === 0) {
    return { ok: false, error: 'label_required' }
  }
  if (draft.kind === 'ssh') {
    const sshTargetId = draft.sshTargetId.trim()
    if (sshTargetId.length === 0) {
      return { ok: false, error: 'ssh_target_required' }
    }
    return { ok: true, connection: { id, label, kind: 'ssh', sshTargetId } }
  }
  const host = draft.tcpHost.trim()
  const port = Number(draft.tcpPort.trim())
  if (host.length === 0) {
    return { ok: false, error: 'tcp_host_required' }
  }
  if (!Number.isInteger(port) || port <= 0) {
    return { ok: false, error: 'tcp_port_required' }
  }
  return { ok: true, connection: { id, label, kind: 'tcp', tcp: { host, port } } }
}
