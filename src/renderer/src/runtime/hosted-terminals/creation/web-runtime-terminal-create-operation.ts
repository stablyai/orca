import { projectRetainedWebRuntimeCreate } from './web-runtime-retained-terminal-create'
import { startWebRuntimeAgentTerminalCreate } from './web-runtime-agent-terminal-create'
import { useAppStore } from '@/store/index'
import { captureTerminalCreationNavigation } from '@/store/terminals/terminal-creation-navigation'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../shared/non-secure-context-uuid'
import { TERMINAL_FRESH_ADMISSION_PLACEMENT_RUNTIME_CAPABILITY } from '../../../../../shared/session-tabs-runtime-capabilities'
import {
  runtimeEnvironmentCapabilityProof,
  type RuntimeCapabilityProof
} from '../../rpc/compatibility/runtime-capability-proof'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import type { RuntimeMobileSessionCreateTerminalResult } from '../../../../../shared/runtime-session-contracts'
import { toRuntimeExecutionHostId } from '../../../../../shared/execution-host'
import { translate } from '../../../i18n/i18n'
import { toRuntimeWorktreeSelector } from '../../rpc/targets/runtime-worktree-selector'
import { resolveWebRuntimeSessionEnvironmentId } from '../../web-session-tabs-sync/workspace-selection/web-runtime-session-workspace-routing'
import {
  clearWebSessionFocusIntentIfMatches,
  recordWebSessionFocusIntent,
  resolveWebSessionVisibleTabId
} from '../../web-session-tabs-sync/navigation/web-session-focus-intent'
import {
  forgetWebSessionTerminalPlacement,
  webTerminalPlacementParentTabId
} from '../placement/web-session-terminal-placement'
import {
  captureRuntimeEnvironmentCall,
  captureWebSessionIntentOwner,
  isWebRuntimeSessionActive,
  matchesWebSessionIntentOwner
} from '../../web-session-tabs-sync/identity/web-runtime-session-environment'
import { refreshWebRuntimeSessionTabsSnapshot } from '../../web-session-tabs-sync/inventory/web-runtime-session-snapshot'
import type {
  CreatedWebRuntimeSessionTerminal,
  CreateWebRuntimeSessionTerminalOnHostArgs
} from './terminal-create-contracts'
import {
  readActiveWorkspaceSelection,
  restoreActiveWorkspaceSelection,
  selectWebRuntimeSessionWorktree,
  type WebRuntimeSessionWorkspaceSelectionRollback
} from '../../web-session-tabs-sync/workspace-selection/web-runtime-session-workspace-selection'
import { createdTerminalLeafId } from './web-runtime-terminal-identity'
import {
  settleWebRuntimeTerminalPlacement,
  projectAcceptedWebRuntimeSplitGroup,
  recordAcceptedWebRuntimeTerminalPlacement
} from '../placement/web-runtime-terminal-placement-settlement'
import { buildPlainCreateTerminalParams } from './web-runtime-plain-terminal-create-params'

export async function createWebRuntimeSessionTerminalResult(
  args: CreateWebRuntimeSessionTerminalOnHostArgs
): Promise<CreatedWebRuntimeSessionTerminal> {
  const environmentId = resolveWebRuntimeSessionEnvironmentId(args.environmentId, null)
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return {
      outcome: {
        status: 'failed',
        message: translate(
          'auto.runtime.webRuntimeSession.remoteHostDisconnected',
          'The workspace is not connected to a remote Orca host.'
        )
      }
    }
  }
  const intentOwner = captureWebSessionIntentOwner(environmentId)
  const callEnvironment = captureRuntimeEnvironmentCall(environmentId, intentOwner.pairingRevision)
  const plain = !(args.launchAgent ?? args.agent)
  let navigation = plain ? captureTerminalCreationNavigation() : null
  let activate = args.activate !== false
  let targetGroupId = args.targetGroupId
  let legacySplitGroupId: string | undefined

  let workspaceSelectionRollback: WebRuntimeSessionWorkspaceSelectionRollback | null = null
  if (!plain && args.selectWorktree !== false) {
    const previous = readActiveWorkspaceSelection()
    selectWebRuntimeSessionWorktree(args.worktreeId, environmentId)
    workspaceSelectionRollback = {
      previous,
      applied: {
        worktreeId: args.worktreeId,
        executionHostId: toRuntimeExecutionHostId(environmentId)
      }
    }
  }
  let hostCreated = false
  let createdTabId: string | undefined
  let createdLeafId: string | undefined
  let plainProof: RuntimeCapabilityProof | undefined
  try {
    const agent = args.launchAgent ?? args.agent
    const agentArgsOverride =
      args.agentArgs !== undefined
        ? args.agentArgs
        : args.agentSessionKind === 'resume'
          ? args.launchConfig?.agentArgs
          : undefined
    if (agent) {
      const creation = startWebRuntimeAgentTerminalCreate(
        args,
        environmentId,
        callEnvironment,
        agent,
        agentArgsOverride
      )
      const created = await creation.result
      hostCreated = true
      const legacyAlreadyPlacedInGroup = creation.wasLegacyPlacedInGroup()
      createdTabId = created.terminal.tabId
      createdLeafId = legacyAlreadyPlacedInGroup
        ? created.terminal.leafId
        : createdTerminalLeafId(created.terminal)
      if (args.targetGroupId && createdTabId && !legacyAlreadyPlacedInGroup) {
        await callEnvironment({
          method: 'session.tabs.move',
          params: {
            worktree: toRuntimeWorktreeSelector(args.worktreeId),
            tabId: createdTabId,
            targetGroupId: args.targetGroupId,
            kind: 'move-to-group'
          },
          timeoutMs: 15_000
        })
      }
    } else {
      const proof = await runtimeEnvironmentCapabilityProof(
        environmentId,
        TERMINAL_FRESH_ADMISSION_PLACEMENT_RUNTIME_CAPABILITY
      )
      plainProof = proof
      if (
        !matchesWebSessionIntentOwner(intentOwner) ||
        proof.pairingRevision !== intentOwner.pairingRevision
      ) {
        throw new Error('The workspace host changed before the terminal request.')
      }
      if (args.split) {
        if (proof.supported) {
          targetGroupId = createBrowserUuid()
        } else {
          // Select the old placement route before dispatch; a refused/uncertain create never switches routes.
          activate = activate && (navigation?.current() ?? true)
          navigation?.dispose()
          legacySplitGroupId =
            useAppStore
              .getState()
              .createEmptySplitGroup(
                args.worktreeId,
                args.split.besideGroupId,
                args.split.direction
              ) ?? undefined
          if (!legacySplitGroupId) {
            throw new Error('The terminal group is no longer available.')
          }
          targetGroupId = legacySplitGroupId
          navigation = captureTerminalCreationNavigation()
        }
      }
      const params = await buildPlainCreateTerminalParams(environmentId, {
        ...args,
        targetGroupId,
        split: proof.supported ? args.split : undefined,
        initialSize: proof.supported ? args.initialSize : undefined,
        clientMutationId: args.clientMutationId ?? createBrowserUuid()
      })
      const created = await callRuntimeRpc<RuntimeMobileSessionCreateTerminalResult>(
        { kind: 'environment', environmentId },
        'session.tabs.createTerminal',
        params,
        {
          timeoutMs: 15_000,
          expectedEnvironmentPairingRevision: proof.pairingRevision,
          expectedEnvironmentRuntimeId: proof.runtimeId
        }
      )
      hostCreated = true
      createdTabId = created.tab.id
      createdLeafId = created.tab.leafId
      activate = activate && (navigation?.current() ?? true)
      navigation?.dispose()
      projectAcceptedWebRuntimeSplitGroup(args, proof.supported, targetGroupId)
      if (activate && args.selectWorktree !== false && matchesWebSessionIntentOwner(intentOwner)) {
        selectWebRuntimeSessionWorktree(args.worktreeId, environmentId)
      }
    }
    recordAcceptedWebRuntimeTerminalPlacement(args, environmentId, createdTabId, targetGroupId)
    if (activate && createdTabId && matchesWebSessionIntentOwner(intentOwner)) {
      // Intent lets reconciliation focus this new terminal instead of sticky-keeping the previous tab.
      recordWebSessionFocusIntent(
        intentOwner,
        args.worktreeId,
        createdTabId,
        createdLeafId,
        plain ? resolveWebSessionVisibleTabId(useAppStore.getState(), args.worktreeId) : undefined
      )
    }
    if (plain) {
      navigation = captureTerminalCreationNavigation()
    }
    const placementTabId =
      createdTabId && (targetGroupId || args.afterTabId) ? createdTabId : undefined
    await refreshWebRuntimeSessionTabsSnapshot(environmentId, args.worktreeId, {
      expectedEnvironmentPairingRevision: intentOwner.pairingRevision,
      // Publication can beat RPC response; replay once caller intent exists.
      acceptCurrentSnapshot: Boolean(createdTabId) && (activate || Boolean(placementTabId)),
      // Require a post-create list; deduped in-flight lists may predate placement.
      ...(placementTabId ? { afterCurrentInFlight: true } : {})
    })
    if (plain && navigation?.current() === false) {
      activate = false
      if (createdTabId) {
        clearWebSessionFocusIntentIfMatches(
          intentOwner,
          args.worktreeId,
          createdTabId,
          createdLeafId
        )
      }
    }
    if (placementTabId) {
      await settleWebRuntimeTerminalPlacement(
        environmentId,
        args.worktreeId,
        webTerminalPlacementParentTabId(placementTabId),
        {
          groupId: targetGroupId,
          afterTabId: args.afterTabId,
          activate,
          ...(plain ? { canActivate: () => navigation?.current() === true } : {})
        }
      )
    }
    return {
      outcome: { status: 'created' },
      ...(createdTabId ? { hostTabId: createdTabId } : {})
    }
  } catch (error) {
    const retainedTabId = plain
      ? projectRetainedWebRuntimeCreate(error, args, {
          environmentId,
          intentOwner,
          proof: plainProof,
          targetGroupId,
          activate,
          navigation
        })
      : null
    if (retainedTabId) {
      return { outcome: { status: 'retained' }, hostTabId: retainedTabId }
    }
    const message = error instanceof Error ? error.message : String(error)
    console.warn(
      hostCreated
        ? '[web-runtime-session] terminal created but reconciliation failed:'
        : '[web-runtime-session] failed to create terminal:',
      message
    )
    if (createdTabId) {
      // Expire create placement or later user drags can be yanked back.
      forgetWebSessionTerminalPlacement({
        environmentId,
        worktreeId: args.worktreeId,
        hostTabId: webTerminalPlacementParentTabId(createdTabId)
      })
    }
    if (!hostCreated && workspaceSelectionRollback) {
      restoreActiveWorkspaceSelection(workspaceSelectionRollback)
    }
    // Accepted creation must not report failure and invite duplicate agent retries with new operation IDs.
    return {
      outcome: hostCreated ? { status: 'created' } : { status: 'failed', message },
      ...(createdTabId ? { hostTabId: createdTabId } : {}),
      ...(hostCreated ? {} : { hostFailed: true as const })
    }
  } finally {
    navigation?.dispose()
    if (legacySplitGroupId) {
      useAppStore.getState().closeEmptyGroup(args.worktreeId, legacySplitGroupId)
    }
  }
}
