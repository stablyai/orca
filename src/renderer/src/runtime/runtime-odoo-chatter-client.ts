// Chatter-specific transport (edit / mention search / attachment upload) split
// out of runtime-odoo-client.ts to keep that file under the max-lines budget;
// re-exported there so callers keep a single import path for every `odooX` fn.
import type {
  OdooAttachmentUpload,
  OdooMentionSuggestion,
  OdooMutationResult
} from '../../../shared/odoo-types'
import { describeOdooAttachmentUploadOverLimit } from '../../../shared/odoo-attachment-upload-limit'
import { callRuntimeRpc } from './runtime-rpc-client'
import { isRuntimeProviderSearchQueryWithinLimit } from './runtime-provider-search-bounds'
import { getOdooRuntimeTarget, type RuntimeOdooSettings } from './odoo-runtime-target'

export async function odooUpdateTicketComment(
  settings: RuntimeOdooSettings,
  messageId: number,
  body: string,
  instanceId?: string | null
): Promise<OdooMutationResult> {
  const target = getOdooRuntimeTarget(settings)
  const args = { id: messageId, body, instanceId: instanceId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<OdooMutationResult>(target, 'odoo.updateTicketComment', args, {
        timeoutMs: 30_000
      })
    : window.api.odoo.updateTicketComment(args)
}

export async function odooSearchMentionCandidates(
  settings: RuntimeOdooSettings,
  ticketId: number,
  query: string,
  instanceId?: string | null
): Promise<OdooMentionSuggestion[]> {
  if (!isRuntimeProviderSearchQueryWithinLimit(query)) {
    return []
  }
  const target = getOdooRuntimeTarget(settings)
  const args = { ticketId, query, instanceId: instanceId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<OdooMentionSuggestion[]>(target, 'odoo.searchMentionCandidates', args, {
        timeoutMs: 30_000
      })
    : window.api.odoo.searchMentionCandidates(args)
}

export async function odooUploadTicketAttachments(
  settings: RuntimeOdooSettings,
  ticketId: number,
  files: OdooAttachmentUpload[],
  instanceId?: string | null
): Promise<{ ok: true; ids: number[] } | { ok: false; error: string }> {
  // Why: cap client-side before the payload hits the RPC/SSH transport rather
  // than letting a large call stall the channel or fail deep in main.
  const overLimitError = describeOdooAttachmentUploadOverLimit(files)
  if (overLimitError) {
    return { ok: false, error: overLimitError }
  }
  const target = getOdooRuntimeTarget(settings)
  const args = { ticketId, files, instanceId: instanceId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<{ ok: true; ids: number[] } | { ok: false; error: string }>(
        target,
        'odoo.uploadTicketAttachments',
        args,
        { timeoutMs: 30_000 }
      )
    : window.api.odoo.uploadTicketAttachments(args)
}
