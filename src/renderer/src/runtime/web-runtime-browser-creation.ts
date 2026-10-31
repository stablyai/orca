import type { BrowserPageCreationPlacement } from '../../../shared/browser-client-host-placement'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { BrowserTabCreateResult } from '../../../shared/runtime-types'
import { translate } from '../i18n/i18n'
import { useAppStore } from '../store'
import { hasRuntimeRpcErrorCode } from '../../../shared/runtime-rpc-error-code'
import { unwrapRuntimeRpcResult } from './runtime-rpc-result'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import { hasMaterializedWebRuntimeBrowserPage } from './web-runtime-browser-materialization'
import { waitForWebRuntimeBrowserPageMaterialization } from './web-runtime-browser-materialization-wait'
import {
  isStagedWebRuntimeBrowserTabLive,
  resolveStagedWebRuntimeBrowserTabGroupId,
  StagedWebRuntimeBrowserTabCancelledError
} from './web-runtime-browser-tab-staging'
import {
  completeWebRuntimeBrowserCreation,
  createWebRuntimeBrowserCreationContext,
  rehomeWebRuntimeBrowserCreation,
  resolveWebRuntimeBrowserClientTargetGroupId,
  restageWebRuntimeBrowserCreation,
  stageWebRuntimeBrowserCreation,
  type CreateWebRuntimeSessionBrowserTabArgs
} from './web-runtime-browser-creation-context'
import {
  finishWebRuntimeBrowserCreationFailure,
  prepareWebRuntimeBrowserCreationFailure
} from './web-runtime-browser-creation-failure'
import {
  pauseAfterE2eWebRuntimeBrowserCreate,
  pauseDuringE2eWebRuntimeBrowserClientHostPreparation
} from './web-runtime-browser-creation-e2e-fault'
import { isWebRuntimeSessionActive } from './web-runtime-session-environment'
import { refreshWebRuntimeSessionTabsSnapshot } from './web-runtime-session-snapshot'
import { registerPairedBrowserTabCreator } from '../store/slices/browser/paired-browser-tab-creator'
import {
  forgetStagedBrowserTabHandover,
  wasStagedBrowserTabHandedToFrames
} from '@/lib/staged-browser-frame-handover'

export async function createWebRuntimeSessionBrowserTab(
  args: CreateWebRuntimeSessionBrowserTabArgs
): Promise<boolean> {
  const environmentId =
    args.environmentId?.trim() ??
    useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim() ??
    null
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return false
  }
  const context = createWebRuntimeBrowserCreationContext(args, environmentId)
  let stagedWorkspaceId: string | undefined
  let materializedPageId: string | undefined
  try {
    stageWebRuntimeBrowserCreation(context)
    stagedWorkspaceId = context.staged?.workspaceId
    const placementPreference = args.placementPreference ?? 'auto'
    let placement: BrowserPageCreationPlacement = { kind: 'server' }
    // Always probe live placement: cached pre-upgrade capabilities can pin capable pairs to server placement for a catalog TTL. Incapable/unreachable hosts pay an extra round-trip (up to 15s), then create and any non-definitive-failure cleanup.
    if (placementPreference !== 'server') {
      try {
        await pauseDuringE2eWebRuntimeBrowserClientHostPreparation()
        placement = await window.api.runtimeEnvironments.prepareBrowserClientHostPlacement({
          selector: environmentId,
          expectedPairingRevision: context.intentOwner.pairingRevision,
          preference: placementPreference
        })
      } catch (error) {
        console.warn('[web-runtime-session] failed to prepare client browser host:', error)
        throw new Error(
          translate(
            'browser.clientHosted.preparationFailed',
            "Couldn't start the remote browser on this desktop. Check the paired connection and try again."
          ),
          { cause: error }
        )
      }
    }
    restageWebRuntimeBrowserCreation(context, placement.kind === 'client')
    context.createAttempted = true
    const navigateAfterCreate =
      args.waitForRegistration === true && args.url && args.url !== 'about:blank'
    const created = unwrapRuntimeRpcResult(
      (await context.callEnvironment({
        method: 'browser.tabCreate',
        params: {
          worktree: toRuntimeWorktreeSelector(args.worktreeId),
          url: navigateAfterCreate ? undefined : args.url,
          ...(context.hostSupportsKnownPageId ? { page: context.provisionalPageId } : {}),
          ...(placement.kind === 'client' ? { placement } : {}),
          profileId: args.profileId ?? undefined,
          activate: context.shouldFocusOnCreate,
          // Why: `activate` alone made every paired device — the host desktop included — jump to a
          // tab this client created. New hosts read `navigation`; old ones ignore it and keep
          // today's behavior, which is also what keeps their targetGroupId placement working.
          navigation: 'caller',
          // Why: place the new browser in the clicked split group so the host snapshot is authoritative for it (no left-snap).
          ...(args.targetGroupId ? { targetGroupId: args.targetGroupId } : {}),
          // Why: web clients need the local tab now; waiting for host webview registration makes the workspace appear to close.
          waitForRegistration: args.waitForRegistration ?? false
        },
        timeoutMs: 15_000
      })) as RuntimeRpcResponse<BrowserTabCreateResult>
    )
    context.createdPageId = created.browserPageId
    if (navigateAfterCreate) {
      void context
        .callEnvironment({
          method: 'browser.goto',
          params: {
            worktree: toRuntimeWorktreeSelector(args.worktreeId),
            page: created.browserPageId,
            url: args.url
          },
          timeoutMs: 15_000
        })
        .then((response) => unwrapRuntimeRpcResult(response))
        .catch((error) => {
          console.warn(
            '[web-runtime-session] created browser tab navigation failed:',
            error instanceof Error ? error.message : String(error)
          )
        })
    }
    await pauseAfterE2eWebRuntimeBrowserCreate(created.browserPageId)
    // Staged X removes only local rows; catch must retire the host page once create returns its ID.
    // Accepted cancellation bound: until create answers, the unnamed host page can survive up to the RPC timeout, as in unreconciled cleanup.
    // Frame handover replaces staged rows before a pane handle exists; that proves landing, not user cancellation (L284).
    const handedToFrames = (): boolean =>
      stagedWorkspaceId !== undefined &&
      wasStagedBrowserTabHandedToFrames(stagedWorkspaceId, created.browserPageId)
    const stagedClosedByUser = (): boolean =>
      context.staged !== null &&
      !isStagedWebRuntimeBrowserTabLive(context.staged, args.worktreeId) &&
      !handedToFrames()
    if (stagedClosedByUser()) {
      throw new StagedWebRuntimeBrowserTabCancelledError()
    }
    if (created.browserPageId !== context.provisionalPageId) {
      rehomeWebRuntimeBrowserCreation(context, created.browserPageId)
    }
    // Judge moved staged tabs in their current group, not the requested one.
    const resolveExpectedGroupId = (): string | undefined =>
      (context.staged
        ? resolveStagedWebRuntimeBrowserTabGroupId(context.staged, args.worktreeId)
        : undefined) ?? resolveWebRuntimeBrowserClientTargetGroupId(args)
    try {
      await refreshWebRuntimeSessionTabsSnapshot(environmentId, args.worktreeId, {
        expectedEnvironmentPairingRevision: context.intentOwner.pairingRevision,
        acceptCurrentSnapshot: true,
        afterCurrentInFlight: true,
        errorMode: 'throw'
      })
    } catch (error) {
      if (
        !handedToFrames() &&
        !hasMaterializedWebRuntimeBrowserPage(
          useAppStore.getState(),
          environmentId,
          args.worktreeId,
          created.browserPageId,
          resolveExpectedGroupId()
        )
      ) {
        throw error
      }
    }
    const expectedGroupId = resolveExpectedGroupId()
    let materialized =
      handedToFrames() ||
      hasMaterializedWebRuntimeBrowserPage(
        useAppStore.getState(),
        environmentId,
        args.worktreeId,
        created.browserPageId,
        expectedGroupId
      )
    if (!materialized) {
      materialized = await waitForWebRuntimeBrowserPageMaterialization({
        environmentId,
        worktreeId: args.worktreeId,
        remotePageId: created.browserPageId,
        ...(expectedGroupId ? { expectedGroupId } : {}),
        handedToFrames
      })
    }
    if (!materialized && expectedGroupId) {
      // Older hosts may create without group targeting; retain the live tab even in the wrong split.
      materialized = hasMaterializedWebRuntimeBrowserPage(
        useAppStore.getState(),
        environmentId,
        args.worktreeId,
        created.browserPageId
      )
      if (materialized) {
        console.warn(
          '[web-runtime-session] created browser tab landed outside the requested group:',
          expectedGroupId
        )
      }
    }
    if (!materialized) {
      throw new Error('The created browser tab did not materialize in the client.')
    }
    // Materialization can see a host-owned row after staged X; recheck staged liveness after the wait or success skips required host cleanup.
    if (stagedClosedByUser()) {
      throw new StagedWebRuntimeBrowserTabCancelledError()
    }
    // Materialized rows belong to the snapshot; later failures must not unwind them as staging.
    completeWebRuntimeBrowserCreation(context)
    materializedPageId = created.browserPageId
  } catch (error) {
    const failure = prepareWebRuntimeBrowserCreationFailure(context, error)
    if (failure.cleanupPageId) {
      try {
        const closeResult = unwrapRuntimeRpcResult(
          (await context.callEnvironment({
            method: 'browser.tabClose',
            params: {
              worktree: toRuntimeWorktreeSelector(args.worktreeId),
              page: failure.cleanupPageId
            },
            timeoutMs: 15_000
          })) as RuntimeRpcResponse<{ closed: boolean }>
        )
        if (!closeResult.closed) {
          throw new Error('The paired runtime did not close the unreconciled browser tab.')
        }
        await refreshWebRuntimeSessionTabsSnapshot(environmentId, args.worktreeId, {
          expectedEnvironmentPairingRevision: context.intentOwner.pairingRevision,
          afterCurrentInFlight: true,
          errorMode: 'throw'
        })
        if (
          hasMaterializedWebRuntimeBrowserPage(
            useAppStore.getState(),
            environmentId,
            args.worktreeId,
            failure.cleanupPageId
          )
        ) {
          throw new Error('The closed browser tab remained materialized in the client.')
        }
      } catch (cleanupError) {
        if (
          !context.createdPageId &&
          context.hostSupportsKnownPageId &&
          hasRuntimeRpcErrorCode(cleanupError, 'browser_tab_not_found')
        ) {
          failure.recoveryError = null
        } else {
          failure.recoveryError = cleanupError
          console.warn(
            '[web-runtime-session] failed to clean up unreconciled browser tab:',
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          )
        }
      }
    }
    return finishWebRuntimeBrowserCreationFailure(context, failure, error)
  } finally {
    if (stagedWorkspaceId) {
      forgetStagedBrowserTabHandover(stagedWorkspaceId)
    }
  }
  if (materializedPageId) {
    args.onMaterialized?.(materializedPageId)
  }
  return true
}

registerPairedBrowserTabCreator(createWebRuntimeSessionBrowserTab)
