import { toast } from 'sonner'
import { isUnsupportedResult, type CodeIntelResult } from '../../../shared/code-intel-contract'

// Why: providers swallow non-ok results into an empty location list, so a remote
// or SSH worktree looks identical to "no definition found". Surface the real
// reason once per session — a deduped toast — so the user understands the gap
// instead of assuming navigation is broken. Repeated hovers must not spam it.
let notified = false

export function notifyIfRemoteUnsupported(result: CodeIntelResult): void {
  if (notified || !isUnsupportedResult(result) || result.reason !== 'remote-runtime') {
    return
  }
  notified = true
  toast.info('Code intelligence is not available on remote or SSH worktrees yet.')
}

export function resetRemoteUnsupportedToastForTest(): void {
  notified = false
}
