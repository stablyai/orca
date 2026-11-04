import {
  WORKFLOW_SCHEMA_VERSION,
  WorkflowPresetSchema,
  type WorkflowPreset
} from './workflow-definition-schema'
import { isWorkflowJsonRecord } from './workflow-json-record'

type RawPreset = Record<string, unknown>

/** One step per historical version; each takes version N to N+1. Empty until v2 exists. */
const MIGRATIONS: Record<number, (raw: RawPreset) => RawPreset> = {}

export const WORKFLOW_PRESET_MAX_IMPORT_BYTES = 2_000_000

export type WorkflowPresetParseResult =
  | { ok: true; preset: WorkflowPreset; migratedFrom: number | null }
  | { ok: false; error: string }

/** Parse untrusted JSON (an import, or a file on disk) into the current schema. */
export function parseWorkflowPreset(input: unknown): WorkflowPresetParseResult {
  if (!isWorkflowJsonRecord(input)) {
    return { ok: false, error: 'A workflow preset must be a JSON object.' }
  }
  let raw: RawPreset = input
  const declared = raw.schemaVersion
  if (typeof declared !== 'number' || !Number.isInteger(declared) || declared < 1) {
    return { ok: false, error: 'The preset has no valid schemaVersion.' }
  }
  if (declared > WORKFLOW_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `This preset uses schema v${declared}; this Orca reads up to v${WORKFLOW_SCHEMA_VERSION}. Update Orca to open it.`
    }
  }
  for (let version = declared; version < WORKFLOW_SCHEMA_VERSION; version += 1) {
    const migrate = MIGRATIONS[version]
    if (!migrate) {
      return { ok: false, error: `No migration exists from schema v${version}.` }
    }
    raw = { ...migrate(raw), schemaVersion: version + 1 }
  }
  const parsed = WorkflowPresetSchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return {
      ok: false,
      error: `Invalid preset at ${first?.path.join('.') || 'root'}: ${first?.message ?? 'unknown error'}`
    }
  }
  return {
    ok: true,
    preset: parsed.data,
    migratedFrom: declared === WORKFLOW_SCHEMA_VERSION ? null : declared
  }
}

export function parseWorkflowPresetText(text: string): WorkflowPresetParseResult {
  if (new TextEncoder().encode(text).length > WORKFLOW_PRESET_MAX_IMPORT_BYTES) {
    return { ok: false, error: 'The preset file is larger than 2 MB.' }
  }
  try {
    return parseWorkflowPreset(JSON.parse(text))
  } catch {
    return { ok: false, error: 'The file is not valid JSON.' }
  }
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
]

function redactValue(value: unknown, hits: { count: number }): unknown {
  if (typeof value === 'string') {
    let next = value
    for (const pattern of SECRET_PATTERNS) {
      next = next.replace(pattern, () => {
        hits.count += 1
        return '[redacted]'
      })
    }
    return next
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, hits))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactValue(item, hits)])
    )
  }
  return value
}

/** Exports never carry credential-shaped text, even when a user pasted one into an instruction. */
export function serializeWorkflowPresetForExport(preset: WorkflowPreset): {
  text: string
  redactions: number
} {
  const hits = { count: 0 }
  const redacted = redactValue({ ...preset, template: false }, hits)
  return { text: `${JSON.stringify(redacted, null, 2)}\n`, redactions: hits.count }
}
