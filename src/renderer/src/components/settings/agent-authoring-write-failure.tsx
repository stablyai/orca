import { AlertTriangle } from 'lucide-react'
import { translate } from '@/i18n/i18n'

// Why: main now acks catalog/reference authoring only after a durable write, so
// these two codes mean the change never reached disk. Without dedicated copy
// they fall through to the generic "reload and try again" branch, which leaves
// the user unsure whether the edit was applied — the one thing they must know.

export type AgentAuthoringWriteFailureCode =
  | 'agent_catalog_write_failed'
  | 'agent_reference_write_failed'

/** Narrows any catalog/reference mutation result to a durable-write failure, or
 *  null when it is a success or a different rejection. */
export function asAgentAuthoringWriteFailure(result: {
  ok: boolean
  code?: unknown
}): AgentAuthoringWriteFailureCode | null {
  if (result.ok) {
    return null
  }
  const { code } = result
  if (code === 'agent_catalog_write_failed' || code === 'agent_reference_write_failed') {
    return code
  }
  return null
}

/** Single source of the "nothing was saved, retry" wording, shared by the
 *  editor's form banner and the section notice. */
export function agentAuthoringWriteFailureMessage(): string {
  return translate(
    'auto.components.settings.AgentCatalogSection.writeFailedDescription',
    "Orca couldn't save this change to disk, so nothing was changed. Check that the disk isn't full or read-only, then try again."
  )
}

/** Shown after a catalog/reference write is rejected because it could not be
 *  persisted; stays until the next mutation so the failure is not missed. */
export function AgentAuthoringWriteFailureNotice(): React.JSX.Element {
  return (
    <div
      role="alert"
      className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
    >
      <p className="flex items-start gap-2 font-medium text-destructive">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
        <span>
          {translate(
            'auto.components.settings.AgentCatalogSection.writeFailedTitle',
            "Your change wasn't saved"
          )}
        </span>
      </p>
      <p className="text-muted-foreground">{agentAuthoringWriteFailureMessage()}</p>
    </div>
  )
}
