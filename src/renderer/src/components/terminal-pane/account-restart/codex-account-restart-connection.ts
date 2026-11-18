import { useAppStore } from '@/store'
import { currentCodexAccountRestart } from '@/store/terminals/codex-account-restart-continuation'
import { readAccountRestartReceipt } from '../../../../../shared/terminal/pty/lifecycle/account-restart-contract'
import {
  continueCodexAccountRestart,
  dispatchCodexAccountRestart,
  failCodexAccountRestart
} from './codex-account-restart-execution'
import { settleCodexAccountRestart } from './codex-account-restart-settlement'
import type { ConnectPanePtySession } from '../pty-connection/connect-pane-pty-session'
import type { PtyTransport } from '../pty-transport/pty-transport-types'

type ConnectOptions = Parameters<PtyTransport['connect']>[0]

/** One captured attempt supplies dispatch, failure and settlement; live session options may later change. */
export function captureCodexAccountRestartConnection(session: ConnectPanePtySession) {
  const token = session.deps.accountRestartToken
  if (!token) {
    return null
  }
  const request = currentCodexAccountRestart(useAppStore.getState(), token)
  if (!request?.condition || !['claimed', 'preparing', 'dispatched'].includes(request.phase)) {
    return false
  }
  const { condition, startup, resultPtyId } = request
  let error: unknown
  let deferred = false
  const captureFailure = (failure: unknown): void => {
    const receipt = readAccountRestartReceipt(failure)
    const message =
      failure &&
      typeof failure === 'object' &&
      'message' in failure &&
      typeof failure.message === 'string'
        ? failure.message
        : String(failure)
    error = Object.assign(
      new Error(message.slice(0, 4096)),
      receipt ? { data: { accountRestart: receipt } } : {}
    )
  }
  return {
    captureFailure,
    reportFailure: (message: string): void => {
      if (!readAccountRestartReceipt(error)) {
        captureFailure(message)
      }
    },
    continue: (result?: { id: string; incarnationId?: string | null }): boolean =>
      continueCodexAccountRestart(token, result),
    options: (isCurrent: () => boolean): Partial<ConnectOptions> => ({
      ...(startup
        ? {
            command: startup.command,
            env: session.mergeStartupEnvWithPaneIdentity({
              ...startup.env,
              ORCA_AGENT_LAUNCH_TOKEN: token.attemptId
            }),
            launchConfig: startup.launchConfig,
            resumeProviderSession: startup.resumeProviderSession,
            launchAgent: startup.launchAgent,
            launchToken: token.attemptId
          }
        : {}),
      ...(resultPtyId
        ? { sessionId: resultPtyId, attachOnlyView: true as const }
        : { accountRestart: condition }),
      isAccountRestartCurrent: () =>
        isCurrent() && Boolean(currentCodexAccountRestart(useAppStore.getState(), token)),
      onAccountRestartDispatch: () =>
        Boolean(condition && isCurrent() && dispatchCodexAccountRestart(token, condition)),
      onAccountRestartFailure: captureFailure
    }),
    defer: (): boolean => {
      failCodexAccountRestart(token, error, 'deferred')
      deferred = currentCodexAccountRestart(useAppStore.getState(), token)?.phase === 'deferred'
      return deferred
    },
    settle: (
      ptyId: string | null,
      generation: number,
      options: ConnectOptions,
      isCurrent: () => boolean
    ): void => {
      settleCodexAccountRestart(session, token, {
        ptyId,
        generation,
        error,
        deferred,
        retireOptions: () => {
          delete options.accountRestart
          delete options.isAccountRestartCurrent
          delete options.onAccountRestartDispatch
          delete options.onAccountRestartFailure
          options.shouldContinue = isCurrent
        }
      })
      if (ptyId && isCurrent()) {
        session.settlePaneAttachAttempt?.('success')
      }
    }
  }
}
