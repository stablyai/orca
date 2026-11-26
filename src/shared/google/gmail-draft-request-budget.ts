// How much a `gmail draft` may attach: its files travel as base64 inside the one call, beside the
// body, subject and recipients.
import { pairedRequestFileBudget } from '../remote-runtime/paired-request-budget'

/** Raw bytes of attachments, all together; 32 KB is left for a typical body, subject and recipients. */
export const GMAIL_DRAFT_ATTACH_MAX_BYTES = pairedRequestFileBudget(32 * 1024)
