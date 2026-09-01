import { AlertTriangle } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { AgentCatalogSchemaTooNew } from '../../../../shared/data-recovery'

// Why: a profile stamped by a newer build is read-only for authoring, and main
// mints this code before any write is attempted. Unlike the migration block it
// is not retryable, so it needs its own narrowing and copy — not the "try again"
// wording. Like the blocked code it is minted in main's write policy, outside
// the shared mutation-result unions, so consumers narrow it structurally.

export type AgentCatalogSchemaTooNewResult = {
  ok: false
  code: 'agent_catalog_schema_too_new'
  persistedVersion: number
  supportedVersion: number
}

/** Narrows any catalog/reference mutation result to the schema-too-new
 *  rejection, or null when the result is a success or a different failure. */
export function asAgentCatalogSchemaTooNew(result: {
  ok: boolean
  code?: unknown
  persistedVersion?: unknown
  supportedVersion?: unknown
}): AgentCatalogSchemaTooNewResult | null {
  if (result.ok) {
    return null
  }
  const candidate = result
  if (candidate.code !== 'agent_catalog_schema_too_new') {
    return null
  }
  return {
    ok: false,
    code: 'agent_catalog_schema_too_new',
    persistedVersion:
      typeof candidate.persistedVersion === 'number' ? candidate.persistedVersion : 0,
    supportedVersion:
      typeof candidate.supportedVersion === 'number' ? candidate.supportedVersion : 0
  }
}

/** Single source of the read-only wording, shared by the Settings notice and the
 *  app-level data-recovery banner. */
export function agentCatalogSchemaTooNewTitle(): string {
  return translate(
    'auto.components.settings.AgentCatalogSection.schemaTooNewTitle',
    'Custom agents are read-only in this version of Orca'
  )
}

export function agentCatalogSchemaTooNewMessage(): string {
  return translate(
    'auto.components.settings.AgentCatalogSection.schemaTooNewDescription',
    'This profile was saved by a newer version of Orca. Your data is unchanged and agents keep launching, but custom agents cannot be changed here — update Orca to edit them again. Retrying will not help.'
  )
}

/** Version detail; empty when the host did not report usable versions. */
export function agentCatalogSchemaTooNewVersions(state: AgentCatalogSchemaTooNew): string {
  if (state.persistedVersion <= 0 || state.supportedVersion <= 0) {
    return ''
  }
  return translate(
    'auto.components.settings.AgentCatalogSection.schemaTooNewVersions',
    'Profile agent catalog v{{persisted}}; this version of Orca supports v{{supported}}.',
    { persisted: String(state.persistedVersion), supported: String(state.supportedVersion) }
  )
}

/** Persistent (no dismiss, no retry) read-only explanation for Settings. */
export function AgentCatalogSchemaTooNewNotice({
  state
}: {
  state: AgentCatalogSchemaTooNew
}): React.JSX.Element {
  const versions = agentCatalogSchemaTooNewVersions(state)
  return (
    <div
      role="alert"
      className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
    >
      <p className="flex items-start gap-2 font-medium text-destructive">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
        <span>{agentCatalogSchemaTooNewTitle()}</span>
      </p>
      <p className="text-muted-foreground">{agentCatalogSchemaTooNewMessage()}</p>
      {versions ? <p className="text-xs text-muted-foreground">{versions}</p> : null}
    </div>
  )
}
