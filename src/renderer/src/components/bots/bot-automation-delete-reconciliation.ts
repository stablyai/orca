import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { refreshRuntimeEnvironmentCatalog } from '@/runtime/rpc/environment-revisions/runtime-environment-pairing-refresh'
import { getRuntimeEnvironmentRevision } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { BOT_READ_SETTLE_MS, type BotReadSettled } from './bot-read-settled'
import type { BotReadAuthority } from './bot-read-authority'
import type { BotActivityWithAuthority } from './use-bot-activity'

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
    const hasReplacement = (): boolean => {
      const revision = getRuntimeEnvironmentRevision(authority.environmentId)
      return revision !== undefined && revision !== authority.pairingRevision
    }
    if (!hasReplacement()) {
      // The catalog and Activity share one deadline. A failed catalog read may leave the old pairing.
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        refreshRuntimeEnvironmentCatalog(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, deadline - performance.now()))
        })
      ]).finally(() => clearTimeout(timer))
    }
    if (!hasReplacement()) {
      return { ok: false }
    }
  }
  return alive() && performance.now() < deadline ? refreshSettled(deadline) : { ok: false }
}
