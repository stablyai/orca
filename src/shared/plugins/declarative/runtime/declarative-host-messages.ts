import type { OrcaStoredValue } from './declarative-atoms'

/** Fields of the host → guest messages, still unvalidated; each reader checks the ones it uses. */
export type HostMessageFields = {
  document?: unknown
  revision?: unknown
  callback?: unknown
  args?: unknown
  edit?: unknown
  accepted?: unknown
  retryAfterMs?: unknown
  colorScheme?: unknown
  visible?: unknown
  panelId?: unknown
  plugin?: unknown
  workspace?: unknown
  memory?: unknown
  retain?: unknown
}

export function readHostMessage(payload: unknown): HostMessageFields {
  if (typeof payload !== 'object' || payload === null) {
    return {}
  }
  const panel = 'panel' in payload ? payload.panel : undefined
  return {
    document: 'document' in payload ? payload.document : undefined,
    revision: 'revision' in payload ? payload.revision : undefined,
    callback: 'callback' in payload ? payload.callback : undefined,
    args: 'args' in payload ? payload.args : undefined,
    edit: 'edit' in payload ? payload.edit : undefined,
    accepted: 'accepted' in payload ? payload.accepted : undefined,
    retryAfterMs: 'retryAfterMs' in payload ? payload.retryAfterMs : undefined,
    colorScheme: 'colorScheme' in payload ? payload.colorScheme : undefined,
    visible: 'visible' in payload ? payload.visible : undefined,
    panelId: typeof panel === 'object' && panel !== null && 'id' in panel ? panel.id : undefined,
    plugin: 'plugin' in payload ? payload.plugin : undefined,
    workspace: 'workspace' in payload ? payload.workspace : undefined,
    memory: 'memory' in payload ? payload.memory : undefined,
    retain: 'retain' in payload ? payload.retain : undefined
  }
}

/** `{ [key]: { version, value } }` from `ui.hydrate`; null when the scope is absent or malformed. */
export function readStoredValues(raw: unknown): Map<string, OrcaStoredValue> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null
  }
  const values = new Map<string, OrcaStoredValue>()
  for (const [key, entry] of Object.entries(raw)) {
    if (typeof entry !== 'object' || entry === null) {
      continue
    }
    const version = 'version' in entry ? entry.version : undefined
    if (typeof version === 'number' && 'value' in entry) {
      values.set(key, { version, value: entry.value })
    }
  }
  return values
}
