// Whether a bot's host takes a newer field or value. An unknown answer is no: an older host refuses it.
// This app's own host always takes it.
import { botTarget, type BotRef } from '@/lib/bot-hosts'
import { readCachedRuntimeEnvironmentCapability } from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import type { RuntimeCapability } from '../../../../shared/remote-runtime/protocol/protocol-version'

export function botHostTakes(bot: BotRef, capability: RuntimeCapability): boolean {
  const environmentId = runtimeTargetEnvironmentId(botTarget(bot))
  return (
    environmentId === null ||
    readCachedRuntimeEnvironmentCapability(environmentId, capability) === true
  )
}
