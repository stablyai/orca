import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import {
  isRuntimeEnvironmentPairingChangedError,
  refreshRuntimeEnvironmentCatalogWithResult
} from '@/runtime/rpc/environment-revisions/runtime-environment-pairing-refresh'
import {
  getRuntimeEnvironmentRevision,
  onRuntimeEnvironmentRevisionsPublished
} from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { BOT_READ_SETTLE_MS, type BotReadSettled } from './bot-read-settled'
import type { BotReadAuthority } from './bot-read-authority'
import type { BotActivityWithAuthority } from './use-bot-activity'

function waitForCatalog(
  authority: Extract<BotReadAuthority, { kind: 'environment' }>,
  pairingChanged: boolean,
  deadline: number
): Promise<number | undefined> {
  const eligibleRevision = (fresh = false): number | undefined => {
    const current = getRuntimeEnvironmentRevision(authority.environmentId)
    return current !== authority.pairingRevision || (fresh && !pairingChanged) ? current : undefined
  }
  const alreadyCurrent = eligibleRevision()
  if (alreadyCurrent !== undefined) {
    return Promise.resolve(alreadyCurrent)
  }
  return new Promise((resolve) => {
    let finished = false
    const finish = (revision?: number): void => {
      if (finished) {
        return
      }
      finished = true
      unsubscribe()
      clearTimeout(timer)
      resolve(performance.now() < deadline ? revision : undefined)
    }
    const onPublish = (): void => {
      const published = eligibleRevision()
      if (published !== undefined) {
        finish(published)
      }
    }
    const unsubscribe = onRuntimeEnvironmentRevisionsPublished(onPublish)
    const timer = setTimeout(() => finish(), Math.max(0, deadline - performance.now()))
    // A publication can land while the shared refresher still owes a trailing read.
    onPublish()
    if (!finished) {
      void refreshRuntimeEnvironmentCatalogWithResult().then((refreshed) => {
        finish(eligibleRevision(refreshed))
      })
    }
  })
}

export async function reconcileBotAutomationDelete(
  error: unknown,
  authority: BotReadAuthority,
  refreshSettled: (deadline: number) => Promise<BotReadSettled<BotActivityWithAuthority>>,
  alive: () => boolean
): Promise<BotReadSettled<BotActivityWithAuthority>> {
  const deadline = performance.now() + BOT_READ_SETTLE_MS
  if (
    authority.kind === 'environment' &&
    error instanceof RuntimeRpcCallError &&
    error.code === 'runtime_environment_changed'
  ) {
    const qualifiedRevision = await waitForCatalog(
      authority,
      isRuntimeEnvironmentPairingChangedError(error),
      deadline
    )
    if (
      qualifiedRevision === undefined ||
      qualifiedRevision !== getRuntimeEnvironmentRevision(authority.environmentId)
    ) {
      return { ok: false }
    }
  }
  return alive() && performance.now() < deadline ? refreshSettled(deadline) : { ok: false }
}
