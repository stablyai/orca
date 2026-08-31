import type { BrowserPageCreationPlacement } from '../../../shared/browser-client-host-placement'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { BrowserTabCreateResult } from '../../../shared/runtime-types'
import { translate } from '../i18n/i18n'
import { useAppStore } from '../store'
import { hasRuntimeRpcErrorCode, unwrapRuntimeRpcResult } from './runtime-rpc-client'
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
  try {
    stageWebRuntimeBrowserCreation(context)
    const placementPreference = args.placementPreference ?? 'auto'
    let placement: BrowserPageCreationPlacement = { kind: 'server' }
    // Why no cached-capability gate here: the renderer's runtime status can hold a pre-upgrade
    // "cannot client-host" verdict for a whole catalog TTL, and skipping the preparation on it
    // pinned a capable pair to server placement for that long. The preparation reads live status
    // and answers `server` for a runtime that truly cannot host, so staleness now costs a round
    // trip against an incapable host instead of the wrong placement. An unreachable host pays for
    // that on the failure path too: the probe's 15s ceiling, then the tabCreate behind it and the
    // cleanup close its non-definitive failure needs, where before the create never started.
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
    // Why: the strip's X on a staged tab only unwinds this client's rows — it cannot close a host
    // page whose id did not exist when the user clicked. Hand the cancel to the cleanup path in the
    // catch below, which already owns retiring an unreconciled host page.
    // Why (accepted bound): the host page has no name until the create answers, so a cancel during
    // that round-trip leaves it alive for up to the RPC timeout. That is the same bound the
    // unreconciled-cleanup path has always accepted, so no sweep is added for it.
    if (context.staged && !isStagedWebRuntimeBrowserTabLive(context.staged, args.worktreeId)) {
      throw new StagedWebRuntimeBrowserTabCancelledError()
    }
    if (created.browserPageId !== context.provisionalPageId) {
      rehomeWebRuntimeBrowserCreation(context, created.browserPageId)
    }
    try {
      await refreshWebRuntimeSessionTabsSnapshot(environmentId, args.worktreeId, {
        expectedEnvironmentPairingRevision: context.intentOwner.pairingRevision,
        acceptCurrentSnapshot: true,
        afterCurrentInFlight: true,
        errorMode: 'throw'
      })
    } catch (error) {
      if (
        !hasMaterializedWebRuntimeBrowserPage(
          useAppStore.getState(),
          environmentId,
          args.worktreeId,
          created.browserPageId,
          args.clientTargetGroupId ?? args.targetGroupId
        )
      ) {
        throw error
      }
    }
    const expectedGroupId =
      (context.staged
        ? resolveStagedWebRuntimeBrowserTabGroupId(context.staged, args.worktreeId)
        : undefined) ??
      args.clientTargetGroupId ??
      args.targetGroupId
    let materialized = hasMaterializedWebRuntimeBrowserPage(
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
        ...(expectedGroupId ? { expectedGroupId } : {})
      })
    }
    if (!materialized && expectedGroupId) {
      // Why: an older runtime can honor creation but not group targeting; a live tab in
      // the wrong split beats destroying what the user just made.
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
    // Why: materialization only proves *some* workspace in this worktree carries the page — when the
    // host mirrors it under its own id, the predicate goes true even though the staged row the user
    // X-ed is gone. The whole materialization wait above is a live window for that X, so re-check the
    // row here before the stage is surrendered, or the create reports success and never retires the
    // host page.
    if (context.staged && !isStagedWebRuntimeBrowserTabLive(context.staged, args.worktreeId)) {
      throw new StagedWebRuntimeBrowserTabCancelledError()
    }
    // Why: materialization means the snapshot has taken ownership of these rows, so nothing
    // downstream may still unwind them as an optimistic stage.
    return completeWebRuntimeBrowserCreation(context)
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
  }
}
