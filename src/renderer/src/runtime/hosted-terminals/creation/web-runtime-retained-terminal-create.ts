import {
  projectRetainedTerminalStart,
  retainedStartFromRpcError,
  type RetainedProjectionAddress
} from '@/store/terminals/retained-terminal-start'
import type { RetainedTerminalStart } from '../../../../../shared/workspace-layout/retained-terminal-start'
import { focusAcceptedTerminalPane } from '@/store/terminals/terminal-creation-navigation'
import { toWebTerminalSurfaceTabId } from '../../../../../shared/workspace-layout/terminal-surface-id'
import { isValidHostTerminalTabId } from '../../../../../shared/workspace-layout/terminal-tab-id'
import { isCurrentSessionTabsRuntimeFrame } from '../../web-session-tabs-sync/publisher-identity-fences'
import { matchesWebSessionIntentOwner } from '../../web-session-tabs-sync/identity/web-runtime-session-environment'
import { selectWebRuntimeSessionWorktree } from '../../web-session-tabs-sync/workspace-selection/web-runtime-session-workspace-selection'
import { recordAcceptedWebRuntimeTerminalPlacement } from '../placement/web-runtime-terminal-placement-settlement'
import type { RuntimeCapabilityProof } from '../../rpc/compatibility/runtime-capability-proof'
import type { WebSessionIntentOwner } from '../../web-session-tabs-sync/identity/web-session-intent-owner'
import type { CreateWebRuntimeSessionTerminalOnHostArgs } from './terminal-create-contracts'

export function qualifyRetainedWebRuntimeStart(
  retained: RetainedTerminalStart | null,
  context: {
    worktreeId: string
    environmentId: string
    intentOwner: WebSessionIntentOwner
    proof: RuntimeCapabilityProof | undefined
  }
): NonNullable<RetainedProjectionAddress['paired']> | null {
  const { worktreeId, environmentId, intentOwner, proof } = context
  if (
    !proof?.supported ||
    !retained ||
    intentOwner.environmentId !== environmentId ||
    proof.pairingRevision !== intentOwner.pairingRevision ||
    retained.runtimeId !== proof.runtimeId ||
    retained.worktreeId !== worktreeId ||
    !isValidHostTerminalTabId(retained.tabId)
  ) {
    return null
  }
  const current = () =>
    matchesWebSessionIntentOwner(intentOwner) &&
    isCurrentSessionTabsRuntimeFrame(environmentId, retained.runtimeId)
  return current()
    ? { environmentId, runtimeId: proof.runtimeId, pairingRevision: proof.pairingRevision, current }
    : null
}

/** The action's authenticated host identity is checked before deriving a local mirrored address. */
export function projectRetainedWebRuntimeCreate(
  error: unknown,
  args: CreateWebRuntimeSessionTerminalOnHostArgs,
  context: {
    environmentId: string
    intentOwner: WebSessionIntentOwner
    proof: RuntimeCapabilityProof | undefined
    targetGroupId: string | undefined
    activate: boolean
    navigation: { current: () => boolean } | null
  }
): string | null {
  const retained = retainedStartFromRpcError(error)
  const { environmentId, intentOwner, proof, targetGroupId, activate, navigation } = context
  const paired = qualifyRetainedWebRuntimeStart(retained, {
    worktreeId: args.worktreeId,
    environmentId,
    intentOwner,
    proof
  })
  if (!retained || !paired) {
    return null
  }
  if (
    !projectRetainedTerminalStart(retained, {
      worktreeId: args.worktreeId,
      tabId: toWebTerminalSurfaceTabId(retained.tabId),
      paired,
      groupId: targetGroupId,
      afterTabId: args.afterTabId,
      shell: args.shell,
      cwd: args.cwd,
      viewMode: args.viewMode,
      ...(args.split
        ? {
            split: { sourceGroupId: args.split.besideGroupId, splitDirection: args.split.direction }
          }
        : {})
    })
  ) {
    return null
  }
  recordAcceptedWebRuntimeTerminalPlacement(args, environmentId, retained.tabId, targetGroupId)
  if (activate && navigation?.current()) {
    if (args.selectWorktree !== false) {
      selectWebRuntimeSessionWorktree(args.worktreeId, environmentId)
    }
    focusAcceptedTerminalPane(toWebTerminalSurfaceTabId(retained.tabId), retained.leafId)
  }
  return retained.tabId
}
