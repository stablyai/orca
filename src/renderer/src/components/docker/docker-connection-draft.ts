import type { DockerConnection } from '../../../../shared/docker-types'

export type DockerConnectionDraft = {
  label: string
  kind: 'ssh' | 'tcp'
  sshTargetId: string
  tcpHost: string
  tcpPort: string
}

export type DockerConnectionDraftResult =
  | { ok: true; connection: DockerConnection }
  | { ok: false; error: string }

/** Validate a connection form draft into a DockerConnection. `id` is supplied by the caller. */
export function buildDockerConnectionFromDraft(
  draft: DockerConnectionDraft,
  id: string
): DockerConnectionDraftResult {
  const label = draft.label.trim()
  if (label.length === 0) {
    return { ok: false, error: 'A label is required.' }
  }
  if (draft.kind === 'ssh') {
    if (draft.sshTargetId.trim().length === 0) {
      return { ok: false, error: 'Select an SSH host.' }
    }
    return { ok: true, connection: { id, label, kind: 'ssh', sshTargetId: draft.sshTargetId } }
  }
  const host = draft.tcpHost.trim()
  const port = Number(draft.tcpPort.trim())
  if (host.length === 0) {
    return { ok: false, error: 'A TCP host is required.' }
  }
  if (!Number.isInteger(port) || port <= 0) {
    return { ok: false, error: 'A valid TCP port is required.' }
  }
  return { ok: true, connection: { id, label, kind: 'tcp', tcp: { host, port } } }
}
