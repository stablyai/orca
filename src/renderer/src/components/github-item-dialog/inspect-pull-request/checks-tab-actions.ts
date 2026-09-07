import type React from 'react'
import { toast } from 'sonner'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  resetGitHubChecksTabForSource,
  updateGitHubChecksTabLocalChecks,
  type GitHubChecksTabState
} from '@/components/github-checks-tab-state'
import { getGitHubRuntimeRepoId, type GitHubRuntimeHost } from '@/lib/github-source-runtime-context'
import { startFixChecksAgent } from '@/lib/fix-checks-agent-launch'
import { buildFixBrokenChecksPrompt } from '@/components/pr-checks-fix-prompt'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import type { GitHubOwnerRepo } from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import { translate } from '@/i18n/i18n'

type RuntimeHost = GitHubRuntimeHost | null

export type ChecksTabActionContext = {
  canUseChecksRepoContext: boolean
  runtimeHost: RuntimeHost
  sourceContext?: TaskSourceContext | null
  repoId: string | null
  repoPath: string | null
  itemNumber: number
  itemRepoId: string
  headSha: string | undefined
  prRepo: GitHubOwnerRepo | null
  mountedRef: { current: boolean }
  committedChecksContextOwnerRef: { current: object }
  nextChecksRefreshRequestIdRef: { current: number }
  activeChecksRefreshRequestIdRef: { current: number | null }
  nextCheckDetailsRequestIdRef: { current: number }
  setChecksState: React.Dispatch<React.SetStateAction<GitHubChecksTabState>>
  setRefreshingOwner: React.Dispatch<
    React.SetStateAction<{ contextOwner: object; requestId: number } | null>
  >
  setRerunningOwner: React.Dispatch<React.SetStateAction<object | null>>
  onChecksUpdated: (checks: PRCheckDetail[]) => void
}

export async function refreshGitHubChecksTab(
  ctx: ChecksTabActionContext,
  expectedContextOwner?: object
): Promise<PRCheckDetail[] | null> {
  if (!ctx.canUseChecksRepoContext) {
    toast.error(
      translate(
        'auto.components.GitHubItemDialog.e7007aa1d8',
        'Unable to refresh checks without a repository path.'
      )
    )
    return null
  }
  const refreshContextOwner = expectedContextOwner ?? ctx.committedChecksContextOwnerRef.current
  if (ctx.committedChecksContextOwnerRef.current !== refreshContextOwner) {
    return null
  }
  const refreshRequestId = ++ctx.nextChecksRefreshRequestIdRef.current
  ctx.activeChecksRefreshRequestIdRef.current = refreshRequestId
  ctx.setRefreshingOwner({ contextOwner: refreshContextOwner, requestId: refreshRequestId })
  try {
    const nextChecks = (await (ctx.runtimeHost
      ? callRuntimeRpc<PRCheckDetail[]>(
          { kind: 'environment', environmentId: ctx.runtimeHost.environmentId },
          'github.prChecks',
          {
            repo: getGitHubRuntimeRepoId(ctx.sourceContext, ctx.repoId ?? ctx.itemRepoId),
            prNumber: ctx.itemNumber,
            headSha: ctx.headSha,
            prRepo: ctx.prRepo,
            noCache: true
          },
          { timeoutMs: 30_000 }
        )
      : window.api.gh.prChecks({
          repoPath: ctx.repoPath ?? '',
          repoId: ctx.repoId ?? undefined,
          sourceContext: ctx.sourceContext,
          prNumber: ctx.itemNumber,
          headSha: ctx.headSha,
          prRepo: ctx.prRepo,
          noCache: true
        }))) as PRCheckDetail[]
    if (
      !ctx.mountedRef.current ||
      ctx.committedChecksContextOwnerRef.current !== refreshContextOwner ||
      ctx.activeChecksRefreshRequestIdRef.current !== refreshRequestId
    ) {
      return null
    }
    ctx.setChecksState((current) =>
      current.contextOwner === refreshContextOwner
        ? updateGitHubChecksTabLocalChecks(resetGitHubChecksTabForSource(current), nextChecks)
        : current
    )
    ctx.onChecksUpdated(nextChecks)
    return nextChecks
  } catch (err) {
    if (
      ctx.mountedRef.current &&
      ctx.committedChecksContextOwnerRef.current === refreshContextOwner &&
      ctx.activeChecksRefreshRequestIdRef.current === refreshRequestId
    ) {
      toast.error(
        err instanceof Error
          ? err.message
          : translate('auto.components.GitHubItemDialog.0bbdc673c1', 'Failed to refresh checks')
      )
    }
    return null
  } finally {
    if (ctx.activeChecksRefreshRequestIdRef.current === refreshRequestId) {
      ctx.activeChecksRefreshRequestIdRef.current = null
    }
    if (ctx.mountedRef.current) {
      ctx.setRefreshingOwner((current) =>
        current?.requestId === refreshRequestId ? null : current
      )
    }
  }
}

export async function rerunGitHubChecksTab(
  ctx: ChecksTabActionContext,
  failedOnly: boolean,
  rerunning: boolean
): Promise<void> {
  if (!ctx.canUseChecksRepoContext || rerunning) {
    return
  }
  const rerunContextOwner = ctx.committedChecksContextOwnerRef.current
  ctx.setRerunningOwner(rerunContextOwner)
  try {
    const result = ctx.runtimeHost
      ? await callRuntimeRpc<Awaited<ReturnType<typeof window.api.gh.rerunPRChecks>>>(
          { kind: 'environment', environmentId: ctx.runtimeHost.environmentId },
          'github.rerunPRChecks',
          {
            repo: getGitHubRuntimeRepoId(ctx.sourceContext, ctx.repoId ?? ctx.itemRepoId),
            prNumber: ctx.itemNumber,
            headSha: ctx.headSha,
            failedOnly,
            prRepo: ctx.prRepo
          },
          { timeoutMs: 30_000 }
        )
      : await window.api.gh.rerunPRChecks({
          repoPath: ctx.repoPath ?? '',
          repoId: ctx.repoId ?? undefined,
          sourceContext: ctx.sourceContext,
          prNumber: ctx.itemNumber,
          headSha: ctx.headSha,
          failedOnly,
          prRepo: ctx.prRepo
        })
    if (
      !ctx.mountedRef.current ||
      ctx.committedChecksContextOwnerRef.current !== rerunContextOwner
    ) {
      return
    }
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(
      result.count === 1
        ? translate('auto.components.GitHubItemDialog.ddafe851e1', 'Check rerun requested')
        : translate('auto.components.GitHubItemDialog.e463ec935f', 'Check reruns requested')
    )
    await refreshGitHubChecksTab(ctx, rerunContextOwner)
  } catch (err) {
    if (
      ctx.mountedRef.current &&
      ctx.committedChecksContextOwnerRef.current === rerunContextOwner
    ) {
      toast.error(
        err instanceof Error
          ? err.message
          : translate('auto.components.GitHubItemDialog.9e7c221b8d', 'Failed to rerun checks')
      )
    }
  } finally {
    if (ctx.mountedRef.current) {
      ctx.setRerunningOwner((current) => (current === rerunContextOwner ? null : current))
    }
  }
}

export async function fixBrokenGitHubChecks({
  item,
  repoId,
  fixingChecks,
  failedChecksLength,
  list,
  setFixingChecks
}: {
  item: GitHubWorkItem
  repoId: string | null
  fixingChecks: boolean
  failedChecksLength: number
  list: PRCheckDetail[]
  setFixingChecks: (value: boolean) => void
}): Promise<void> {
  const targetRepoId = repoId ?? item.repoId
  if (!targetRepoId || fixingChecks) {
    return
  }
  if (failedChecksLength === 0) {
    toast.message(
      translate('auto.components.GitHubItemDialog.1690fd7f4a', 'No broken checks to fix.')
    )
    return
  }

  const basePrompt = buildFixBrokenChecksPrompt({
    reviewKind: 'PR',
    reviewNumber: item.number,
    reviewTitle: item.title,
    reviewUrl: item.url,
    checks: list
  })
  setFixingChecks(true)
  try {
    const started = await startFixChecksAgent({
      item,
      repoId: targetRepoId,
      basePrompt,
      launchSource: 'task_page',
      telemetrySource: 'sidebar',
      openModalFallback: () => {
        toast.error(
          translate(
            'auto.components.GitHubItemDialog.06482d6190',
            'Unable to create a fix workspace automatically.'
          )
        )
      }
    })
    if (started) {
      toast.success(
        translate(
          'auto.components.GitHubItemDialog.28986b3747',
          'Started an AI agent for the broken checks.'
        )
      )
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('Failed to start fix checks agent', err)
    toast.error(
      translate(
        'auto.components.GitHubItemDialog.03e542fcfe',
        'Failed to start an AI agent for the broken checks: {{value0}}',
        { value0: message }
      )
    )
  } finally {
    setFixingChecks(false)
  }
}
