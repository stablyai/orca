// Which host incarnation answered a bot read: a delete it authorizes may only reach that same incarnation.
import { botTarget, callBotRpc, type BotOnHost } from '@/lib/bot-hosts'
import { getRuntimeEnvironmentRevision } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'

export type BotReadAuthority =
  | { kind: 'local' }
  | { kind: 'environment'; environmentId: string; pairingRevision: number }
  /** The pairing revision was unknown when the read was sent: shown, but it authorizes nothing. */
  | { kind: 'environment-unavailable'; environmentId: string }

/** Captured synchronously before a read is sent, so a re-pair during it cannot retarget it. */
export function captureBotReadAuthority(target: RuntimeClientTarget): BotReadAuthority {
  // This app's own runtime: the target lib/bot-hosts resolved is the whole authority.
  if (target.kind === 'local') {
    return target
  }
  const pairingRevision = getRuntimeEnvironmentRevision(target.environmentId)
  return pairingRevision === undefined
    ? { kind: 'environment-unavailable', environmentId: target.environmentId }
    : { kind: 'environment', environmentId: target.environmentId, pairingRevision }
}

export function botReadAuthorityKey(authority: BotReadAuthority): string {
  switch (authority.kind) {
    case 'local':
      return 'local'
    case 'environment':
      return `environment:${authority.environmentId}:${authority.pairingRevision}`
    case 'environment-unavailable':
      return `unavailable:${authority.environmentId}`
  }
}

/** Two reads came from one proven incarnation; an unavailable capture proves none. */
export function sameBotReadAuthority(a: BotReadAuthority, b: BotReadAuthority): boolean {
  return (
    a.kind !== 'environment-unavailable' &&
    b.kind !== 'environment-unavailable' &&
    botReadAuthorityKey(a) === botReadAuthorityKey(b)
  )
}

/** One bot RPC fenced to the incarnation captured before it was sent, with that incarnation. */
export async function callBotRpcWithAuthority<TResult>(
  bot: BotOnHost,
  method: string,
  params: unknown
): Promise<{ result: TResult; authority: BotReadAuthority }> {
  const authority = captureBotReadAuthority(botTarget(bot))
  const result = await callBotRpc<TResult>(
    bot,
    method,
    params,
    authority.kind === 'environment'
      ? { expectedEnvironmentPairingRevision: authority.pairingRevision }
      : undefined
  )
  return { result, authority }
}
