import type { PtyTransport } from '../pty-transport/pty-transport-types'

type InterruptTransport = Pick<PtyTransport, 'getPtyId'>
type InterruptTurn = { ptyId: string; startedAt: number }

const claimedTurns = new WeakMap<InterruptTransport, InterruptTurn>()

/** One interrupt attempt per transport and turn, even when the write outcome is unknown. */
export function claimTerminalHandoffInterrupt(
  transport: InterruptTransport,
  turn: InterruptTurn
): boolean {
  const claimed = claimedTurns.get(transport)
  if (claimed?.ptyId === turn.ptyId && claimed.startedAt === turn.startedAt) {
    return false
  }
  claimedTurns.set(transport, turn)
  return true
}
