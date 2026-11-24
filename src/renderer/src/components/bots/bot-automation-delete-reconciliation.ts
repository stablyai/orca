import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import {
  isRuntimeEnvironmentPairingChangedError,
  refreshRuntimeEnvironmentCatalogWithResult
} from '@/runtime/rpc/environment-revisions/runtime-environment-pairing-refresh'
import {
  getRuntimeEnvironmentRegistration,
  onRuntimeEnvironmentRevisionsPublished
} from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { BOT_READ_SETTLE_MS, type BotReadSettled } from './bot-read-settled'
import type { BotReadAuthority } from './bot-read-authority'
import type { BotActivityWithAuthority } from './use-bot-activity'

type QualifiedRegistration = ReturnType<typeof getRuntimeEnvironmentRegistration>

function waitForCatalog(
  authority: Extract<BotReadAuthority, { kind: 'environment' }>,
  pairingChanged: boolean,
  deadline: number,
  signal: AbortSignal
): Promise<QualifiedRegistration> {
  const currentRegistration = () => getRuntimeEnvironmentRegistration(authority.environmentId)
  const replacement = (): QualifiedRegistration => {
    const current = currentRegistration()
    return current?.revision !== authority.pairingRevision ? current : undefined
  }
  if (signal.aborted || performance.now() >= deadline) {
    return Promise.resolve(undefined)
  }
  const alreadyCurrent = replacement()
  if (alreadyCurrent !== undefined) {
    return Promise.resolve(alreadyCurrent)
  }
  return new Promise((resolve) => {
    let finished = false
    const finish = (registration?: QualifiedRegistration): void => {
      if (finished) {
        return
      }
      finished = true
      unsubscribe()
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      resolve(performance.now() < deadline ? registration : undefined)
    }
    const cancel = (): void => finish()
    const onPublish = (): void => {
      const published = replacement()
      if (published) {
        finish(published)
      }
    }
    const unsubscribe = onRuntimeEnvironmentRevisionsPublished(onPublish)
    const timer = setTimeout(() => finish(), Math.max(0, deadline - performance.now()))
    signal.addEventListener('abort', cancel, { once: true })
    // A publication can land while the shared refresher still owes a trailing read.
    onPublish()
    if (!finished) {
      void refreshRuntimeEnvironmentCatalogWithResult().then((sample) => {
        const sampled = sample?.get(authority.environmentId)
        const current = currentRegistration()
        finish(
          !pairingChanged && sampled === authority.pairingRevision && current?.revision === sampled
            ? current
            : undefined
        )
      })
    }
  })
}

export async function reconcileBotAutomationDelete(
  error: unknown,
  authority: BotReadAuthority,
  refreshSettled: (
    deadline: number,
    canStart?: () => boolean
  ) => Promise<BotReadSettled<BotActivityWithAuthority>>,
  signal: AbortSignal
): Promise<BotReadSettled<BotActivityWithAuthority>> {
  const deadline = performance.now() + BOT_READ_SETTLE_MS
  if (
    authority.kind === 'environment' &&
    error instanceof RuntimeRpcCallError &&
    error.code === 'runtime_environment_changed'
  ) {
    const qualified = await waitForCatalog(
      authority,
      isRuntimeEnvironmentPairingChangedError(error),
      deadline,
      signal
    )
    const canStart = (): boolean =>
      !signal.aborted &&
      qualified !== undefined &&
      qualified === getRuntimeEnvironmentRegistration(authority.environmentId)
    if (canStart() && performance.now() < deadline) {
      return refreshSettled(deadline, canStart)
    }
    return { ok: false }
  }
  return signal.aborted ? { ok: false } : refreshSettled(deadline, () => !signal.aborted)
}
