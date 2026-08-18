import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { SetupDecision } from '../../../../../../shared/worktree/create-types'
import { WORKTREE_SETUP_HOOK_APPROVAL_RUNTIME_CAPABILITY } from '../../../../../../shared/protocol-version'
import { runtimeEnvironmentSupportsCapability } from '../../../../runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../../runtime/runtime-client-target'

function warnSetupHookSkipped(descriptionKey: string, description: string): void {
  toast.warning(
    translate('auto.store.slices.worktrees.create.setupHookSkipped', 'Setup hook skipped'),
    { description: translate(descriptionKey, description) }
  )
}

/**
 * Downgrade a remote setup request to `skip` when the host cannot bind the
 * approval to exact content, so an unverifiable host never runs setup hooks.
 */
export async function resolveRemoteSetupDecision(
  target: RuntimeClientTarget,
  setupDecision: SetupDecision,
  /** True when the user approved real content, so a silent downgrade would lose their choice. */
  hasApproval = false
): Promise<SetupDecision> {
  if (
    target.kind !== 'environment' ||
    setupDecision === 'skip' ||
    (await runtimeEnvironmentSupportsCapability(
      target.environmentId,
      WORKTREE_SETUP_HOOK_APPROVAL_RUNTIME_CAPABILITY
    ))
  ) {
    return setupDecision
  }
  // Why: 'inherit' also reaches here from paths that never prompt, and warning on every
  // hookless create would be noise — an approval is the proof content existed.
  if (setupDecision === 'run' || hasApproval) {
    warnSetupHookSkipped(
      'auto.store.slices.worktrees.create.updateRemoteForSetupHooks',
      'Update the remote Orca server to run approved setup hooks.'
    )
  }
  return 'skip'
}

/**
 * Surface a host-side refusal. `setupReceipt` is absent unless the caller awaits
 * provisioning, so the explicit flag is the only signal on the desktop path.
 */
export function notifyRejectedSetupApproval(args: {
  target: RuntimeClientTarget
  remoteSetupDecision: SetupDecision
  setupApprovalRejected?: boolean
}): void {
  if (
    args.target.kind !== 'environment' ||
    args.remoteSetupDecision === 'skip' ||
    !args.setupApprovalRejected
  ) {
    return
  }
  warnSetupHookSkipped(
    'auto.store.slices.worktrees.create.setupApprovalUnverified',
    'The remote Orca server could not verify your approval, so the setup hook did not run.'
  )
}
