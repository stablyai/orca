/** Moving an SSH host to its managed Orca server on request: the offer's words and the run. */
import { toast } from 'sonner'
import type { SshManagedServerMoveResult } from '../../../shared/ssh-managed-server-move'
import { translate } from '@/i18n/i18n'
import { moveRestartingStoppedTabs } from './ssh-managed-server-move-terminal-tabs'

export function canMoveSshHostToManagedServer(): boolean {
  return typeof window.api.ssh.moveToManagedServer === 'function'
}

export function managedServerMoveOfferText(host: string, terminals: number | undefined): string {
  // Why: a missing or zero count means it was not reported, never that no terminal will restart.
  return terminals
    ? translate(
        'auto.ssh.managedServerMove.offer',
        'Move {{host}} to a managed Orca server for more reliable connections. Its {{count}} open terminals will restart.',
        { host, count: terminals }
      )
    : translate(
        'auto.ssh.managedServerMove.offerUncounted',
        'Move {{host}} to a managed Orca server for more reliable connections. Its open terminals will restart.',
        { host }
      )
}

export function describeManagedServerMove(
  host: string,
  result: SshManagedServerMoveResult
): { level: 'success' | 'error'; message: string } {
  switch (result.outcome) {
    case 'moved':
      return {
        level: 'success',
        message: translate(
          'auto.ssh.managedServerMove.moved',
          '{{host}} now runs a managed Orca server.',
          { host }
        )
      }
    case 'refused':
      return { level: 'error', message: refusedMoveText(host, result) }
    case 'stayed':
      return {
        level: 'error',
        message: translate(
          'auto.ssh.managedServerMove.stayed',
          '{{host}} still runs the relay. SSH Hosts in Settings shows why.',
          { host }
        )
      }
  }
}

function refusedMoveText(
  host: string,
  result: Extract<SshManagedServerMoveResult, { outcome: 'refused' }>
): string {
  if (result.verdict === 'live') {
    return translate(
      'auto.ssh.managedServerMove.refusedLive',
      'Not moved: {{count}} terminals on {{host}} are still running.',
      { host, count: result.terminals }
    )
  }
  // Why: a census that couldn't read the host reports 0, which means unknown, not none.
  return result.terminals > 0
    ? translate(
        'auto.ssh.managedServerMove.refusedUnverifiable',
        'Not moved: Orca couldn’t confirm that {{count}} terminals on {{host}} stopped.',
        { host, count: result.terminals }
      )
    : translate(
        'auto.ssh.managedServerMove.refusedUnverifiableUncounted',
        'Not moved: Orca couldn’t confirm that the terminals on {{host}} stopped.',
        { host }
      )
}

export function managedServerMoveErrorText(host: string, error: unknown): string {
  return translate('auto.ssh.managedServerMove.failed', 'Could not move {{host}}: {{reason}}', {
    host,
    reason: error instanceof Error ? error.message : String(error)
  })
}

const inFlightMoves = new Map<string, Promise<SshManagedServerMoveResult>>()

/** One move per host: a second request while one runs joins it instead of starting another. */
export function moveSshHostToManagedServer(
  targetId: string
): Promise<SshManagedServerMoveResult> | null {
  const move = window.api.ssh.moveToManagedServer
  if (!move) {
    return null
  }
  const running = inFlightMoves.get(targetId)
  if (running) {
    return running
  }
  const started = moveRestartingStoppedTabs(targetId, () => move({ targetId })).finally(() =>
    inFlightMoves.delete(targetId)
  )
  inFlightMoves.set(targetId, started)
  return started
}

export function isSshHostMoveRunning(targetId: string): boolean {
  return inFlightMoves.has(targetId)
}

/** The toast's "Move" path: progress and outcome are reported as toasts. */
export async function moveSshHostFromToast(targetId: string, host: string): Promise<void> {
  const move = moveSshHostToManagedServer(targetId)
  if (!move) {
    return
  }
  const progressId = toast.loading(
    translate('auto.ssh.managedServerMove.running', 'Moving {{host}} to a managed Orca server…', {
      host
    })
  )
  try {
    const report = describeManagedServerMove(host, await move)
    toast[report.level](report.message, { id: progressId })
  } catch (error) {
    toast.error(managedServerMoveErrorText(host, error), { id: progressId })
  }
}
