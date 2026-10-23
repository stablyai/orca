import { hasOnlyKeys, isRecord } from './agent-status-child-work-value-guards'
import { sameWslDistroName } from './windows-path-access'

export type ClaudeResumeOrigin = {
  installationId: string
  machineBinding: string
  host: { kind: 'local' } | { kind: 'wsl'; distro: string }
}

function boundedIdentity(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4096 ||
    value.trim() !== value
  ) {
    return false
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) {
      return false
    }
  }
  return true
}

export function normalizeClaudeResumeOrigin(value: unknown): ClaudeResumeOrigin | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['installationId', 'machineBinding', 'host']) ||
    !boundedIdentity(value.installationId) ||
    !boundedIdentity(value.machineBinding) ||
    !isRecord(value.host)
  ) {
    return undefined
  }
  const host = value.host
  if (host.kind === 'local' && hasOnlyKeys(host, ['kind'])) {
    return {
      installationId: value.installationId,
      machineBinding: value.machineBinding,
      host: { kind: 'local' }
    }
  }
  if (
    host.kind === 'wsl' &&
    hasOnlyKeys(host, ['kind', 'distro']) &&
    boundedIdentity(host.distro)
  ) {
    return {
      installationId: value.installationId,
      machineBinding: value.machineBinding,
      host: { kind: 'wsl', distro: host.distro }
    }
  }
  return undefined
}

export function claudeResumeOriginsEqual(
  left: ClaudeResumeOrigin | undefined,
  right: ClaudeResumeOrigin | undefined
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.installationId === right.installationId &&
    left.machineBinding === right.machineBinding &&
    left.host.kind === right.host.kind &&
    (left.host.kind !== 'wsl' ||
      (right.host.kind === 'wsl' && sameWslDistroName(left.host.distro, right.host.distro)))
  )
}
