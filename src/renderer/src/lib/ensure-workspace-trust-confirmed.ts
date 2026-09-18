import { MODAL_DISMISSED_KEY } from '@/store/slices/modal-slot-dismissal'
import type { AppState } from '@/store/types'
import type { WorkspaceTrustTarget } from '../../../shared/workspace-trust-types'

export type WorkspaceTrustPromptDecision = 'trust-workspace' | 'trust-parent' | 'decline'

/**
 * The single renderer choke point every intake path resolves trust through (Req: Both Intake
 * Choke Points Share the Predicate). `resolveIntake` only reads state; a `'prompt'` outcome is
 * the only branch that opens the dialog, and both branches of that prompt persist their own
 * entry (a decline is never silently dropped — see A Declined Ancestor Does Not Suppress the
 * Prompt). Tolerates an `undefined` result from `resolveIntake` (the web build's fallback proxy
 * for an unimplemented channel) by treating it as no-op, matching every other capability there.
 */
export async function ensureWorkspaceTrustConfirmed(
  state: Pick<AppState, 'openModal'>,
  target: WorkspaceTrustTarget,
  path: string
): Promise<void> {
  // Why: tolerate a host surface that hasn't wired the channel at all (older test/web
  // stubs), not only one where the channel exists but the call itself resolves to
  // `undefined` (the web build's fallback proxy for an unimplemented method).
  const resolution = await window.api?.workspaceTrust?.resolveIntake({ target })
  if (!resolution || resolution.outcome !== 'prompt') {
    return
  }

  const decision = await new Promise<WorkspaceTrustPromptDecision>((resolve) => {
    let settled = false
    const settle = (value: WorkspaceTrustPromptDecision): void => {
      if (settled) {
        return
      }
      settled = true
      resolve(value)
    }
    state.openModal('confirm-workspace-trust', {
      path,
      onResolve: settle,
      // Why: the singleton modal slot can evict this prompt for an unrelated one; without this,
      // the awaiting intake flow would hang forever instead of settling as a decline.
      [MODAL_DISMISSED_KEY]: () => settle('decline')
    })
  })

  if (decision === 'decline') {
    await window.api.workspaceTrust.decide({ target, scope: 'workspace', decision: 'decline' })
    return
  }
  await window.api.workspaceTrust.decide({
    target,
    scope: decision === 'trust-parent' ? 'parent' : 'workspace',
    decision: 'trust'
  })
}
