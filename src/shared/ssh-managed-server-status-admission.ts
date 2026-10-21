/** The managed-server status a retained SSH state carries, admitted field by field. */
import type {
  SshManagedServerLinkedProject,
  SshManagedServerNodeDownloadBlocked,
  SshManagedServerStatus,
  SshManagedServerUpdateNote
} from './ssh-types'
import {
  SSH_MANAGED_SERVER_PHASES,
  SSH_MANAGED_SERVER_RELAY_REASONS,
  SSH_MANAGED_SERVER_UPDATE_STATES
} from './ssh-types'
import {
  isNonNegativeSafeInteger,
  isSshRetainedIdentifier,
  SSH_CONNECTION_ERROR_MAX_UTF8_BYTES,
  SSH_RETAINED_IDENTIFIER_MAX_UTF8_BYTES
} from './ssh-retained-payload-limits'
import { clampUtf8TextPrefix } from './utf8-byte-limits'
import { isNodeDistMirrorAttempt } from './node-dist-mirror'

// Why field-by-field like plainSsh: an unknown kind from a newer host drops alone.
export function admitSshManagedServerStatus(value: unknown): {
  managedServer?: SshManagedServerStatus
} {
  if (!value || typeof value !== 'object' || !('kind' in value)) {
    return {}
  }
  if (value.kind === 'managed' && 'environmentId' in value) {
    if (!isSshRetainedIdentifier(value.environmentId)) {
      return {}
    }
    const update = admitSshManagedServerUpdateNote('update' in value ? value.update : undefined)
    const serving =
      'serving' in value &&
      value.serving &&
      typeof value.serving === 'object' &&
      'state' in value.serving &&
      value.serving.state === 'unverifiable' &&
      'detail' in value.serving &&
      typeof value.serving.detail === 'string'
        ? {
            serving: {
              state: 'unverifiable' as const,
              detail: clampUtf8TextPrefix(value.serving.detail, SSH_CONNECTION_ERROR_MAX_UTF8_BYTES)
            }
          }
        : {}
    const linked = admitSshManagedServerLinkedProjects('linked' in value ? value.linked : undefined)
    return {
      managedServer: {
        kind: 'managed',
        environmentId: value.environmentId,
        ...update,
        ...serving,
        ...linked
      }
    }
  }
  if (value.kind === 'setting-up' && 'phase' in value) {
    const phase = SSH_MANAGED_SERVER_PHASES.find((entry) => entry === value.phase)
    return phase ? { managedServer: { kind: 'setting-up', phase } } : {}
  }
  if (value.kind !== 'relay' || !('reason' in value)) {
    return {}
  }
  const reason = SSH_MANAGED_SERVER_RELAY_REASONS.find((entry) => entry === value.reason)
  if (!reason) {
    return {}
  }
  const detail = 'detail' in value && typeof value.detail === 'string' ? value.detail : ''
  const terminals = 'terminals' in value ? value.terminals : undefined
  return {
    managedServer: {
      kind: 'relay',
      reason,
      ...(detail
        ? { detail: clampUtf8TextPrefix(detail, SSH_CONNECTION_ERROR_MAX_UTF8_BYTES) }
        : {}),
      ...(isNonNegativeSafeInteger(terminals) ? { terminals } : {}),
      ...('terminalsElsewhere' in value && value.terminalsElsewhere === true
        ? { terminalsElsewhere: true }
        : {}),
      ...('canLeaveBehind' in value && value.canLeaveBehind === true
        ? { canLeaveBehind: true }
        : {}),
      ...('held' in value && value.held === true ? { held: true } : {}),
      ...('contactLost' in value && value.contactLost === true ? { contactLost: true } : {}),
      ...admitNodeDownloadBlocked(
        'nodeDownloadBlocked' in value ? value.nodeDownloadBlocked : null
      ),
      ...('bridged' in value && value.bridged === true ? { bridged: true } : {})
    }
  }
}

// Why alone: an unknown mirror state from a newer build drops to the plain try-again line.
function admitNodeDownloadBlocked(value: unknown): {
  nodeDownloadBlocked?: SshManagedServerNodeDownloadBlocked
} {
  if (!value || typeof value !== 'object' || !('mirror' in value)) {
    return {}
  }
  return isNodeDistMirrorAttempt(value.mirror)
    ? { nodeDownloadBlocked: { mirror: value.mirror } }
    : {}
}

const SSH_MANAGED_SERVER_LINKED_MAX_ENTRIES = 64

function admitSshManagedServerLinkedProjects(value: unknown): {
  linked?: SshManagedServerLinkedProject[]
} {
  if (!Array.isArray(value)) {
    return {}
  }
  const linked = value
    .slice(0, SSH_MANAGED_SERVER_LINKED_MAX_ENTRIES)
    .flatMap((entry: unknown): SshManagedServerLinkedProject[] =>
      entry &&
      typeof entry === 'object' &&
      'path' in entry &&
      typeof entry.path === 'string' &&
      entry.path &&
      'automations' in entry &&
      isNonNegativeSafeInteger(entry.automations)
        ? [
            {
              path: clampUtf8TextPrefix(entry.path, SSH_RETAINED_IDENTIFIER_MAX_UTF8_BYTES),
              automations: entry.automations
            }
          ]
        : []
    )
  return linked.length > 0 ? { linked } : {}
}

// Why alone: an unknown note from a newer host drops without hiding that the host is managed.
function admitSshManagedServerUpdateNote(value: unknown): { update?: SshManagedServerUpdateNote } {
  if (!value || typeof value !== 'object' || !('state' in value)) {
    return {}
  }
  const state = SSH_MANAGED_SERVER_UPDATE_STATES.find((entry) => entry === value.state)
  if (!state) {
    return {}
  }
  const detail = 'detail' in value && typeof value.detail === 'string' ? value.detail : ''
  return {
    update: {
      state,
      ...(detail
        ? { detail: clampUtf8TextPrefix(detail, SSH_CONNECTION_ERROR_MAX_UTF8_BYTES) }
        : {})
    }
  }
}
