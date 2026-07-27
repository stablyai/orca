import { toast } from 'sonner'
import type { BrowserCookieImportSummary } from '../../../shared/types'

// Why: a degraded import returns ok:true with a warning, so every call site must route it to a
// warning toast instead of reporting an unqualified success (#9355).
export function emitBrowserCookieImportToast(
  summary: BrowserCookieImportSummary,
  successMessage: string
): void {
  if (summary.warning) {
    toast.warning(summary.warning)
    return
  }
  toast.success(successMessage)
}
