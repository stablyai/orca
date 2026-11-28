import {
  HOST_ACCOUNT_SIGN_IN_OWNER_SILENCE_MS,
  HOST_ACCOUNT_SIGN_IN_SETTLED_PHASES,
  type HostAccountSignInProvider,
  type HostAccountSignInStatus
} from './host-account-sign-in-types'

// Why above the host's 20s long poll: an unchanged flow answers at its own deadline, not ours.
const WAIT_TIMEOUT_MS = 35_000
// Why above the host's own 60s: a current host names its failure first; this ends hosts that predate it.
const PROMPT_DEADLINE_MS = 90_000
// Why: older hosts end a flow nobody asked about for 90s, so retrying a lost answer longer is moot there.
const RETRY_WINDOW_MS = 80_000
const RETRY_DELAY_MS = 2_000
const MAX_RETRY_DELAY_MS = 15_000

/** What the run reads of a status; each client decodes the account lists its own way. */
type FlowStatus = Omit<HostAccountSignInStatus, 'claude' | 'codex'>

/** How one client reaches the host's accounts.hostSignIn* methods, and words what it shows. */
export type HostAccountSignInTransport<TStatus extends FlowStatus = HostAccountSignInStatus> = {
  start: (params: { provider: HostAccountSignInProvider; accountId?: string }) => Promise<TStatus>
  wait: (params: { flowId: string; afterRevision: number }, timeoutMs: number) => Promise<TStatus>
  submitCode: (params: { flowId: string; code: string }) => Promise<TStatus>
  cancel: (params: { flowId: string }) => Promise<TStatus>
  /** A timeout or dropped connection, worth asking again; a refusal is final. */
  isLostAnswer: (error: unknown) => boolean
  /** The host's failure in the client's language. */
  failureText: (status: FlowStatus) => string
  /** What a cancelled sign-in throws, so callers can stay quiet about it. */
  cancelledText: string
}

/** Runs `request`, asking again after lost answers until the retry window closes. */
export async function retryLostAnswers<T>(
  request: () => Promise<T>,
  isLostAnswer: (error: unknown) => boolean,
  windowMs = RETRY_WINDOW_MS
): Promise<T> {
  const giveUpAt = Date.now() + windowMs
  for (;;) {
    try {
      return await request()
    } catch (error) {
      if (!isLostAnswer(error) || Date.now() >= giveUpAt) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
    }
  }
}

/**
 * One sign-in this client runs on a host: start, follow the host's flow until it settles, relay a
 * pasted code, and deliver a Cancel even when the host answers late. Settles with the signed-in
 * status, or throws the failure (cancelledText once cancelled).
 */
export class HostAccountSignInRun<TStatus extends FlowStatus = HostAccountSignInStatus> {
  status: TStatus | null = null
  cancelRequested = false
  private following = false
  /** The host acknowledged the cancel (its flow is stopping or settled). */
  private cancelDelivered = false
  /** A cancelled run stops asking an unreachable host after this. */
  private cancelGiveUpAt = Number.POSITIVE_INFINITY
  /** When the host last answered; past its owner silence, it has dropped the flow. */
  private answeredAt = Date.now()
  private lostInARow = 0

  constructor(
    readonly provider: HostAccountSignInProvider,
    /** The saved account to re-authenticate; undefined adds a new one. */
    readonly accountId: string | undefined,
    private readonly transport: HostAccountSignInTransport<TStatus>,
    private readonly onChange: () => void
  ) {}

  async run(): Promise<TStatus> {
    try {
      return await this.follow()
    } catch (error) {
      // Why: after a Cancel, whatever ended the run is what the person asked for.
      if (this.cancelRequested && this.status?.phase !== 'signedIn') {
        throw new Error(this.transport.cancelledText)
      }
      throw error
    }
  }

  /** Asks the host to stop; rejects when it could not be told yet, though the run keeps asking. */
  async cancel(): Promise<void> {
    if (!this.cancelRequested) {
      this.cancelRequested = true
      this.cancelGiveUpAt = Date.now() + RETRY_WINDOW_MS
    }
    this.onChange()
    if (this.following) {
      await this.deliverCancel()
    }
  }

  async submitCode(code: string): Promise<void> {
    const flowId = this.status?.flowId
    if (!flowId || this.cancelRequested) {
      throw new Error('This sign-in is no longer active in this client.')
    }
    this.advance(await this.transport.submitCode({ flowId, code }))
  }

  private advance(status: TStatus): void {
    const current = this.status
    // A slow answer, or one for another flow, never rolls the status back.
    this.answeredAt = Date.now()
    this.lostInARow = 0
    if (current && (status.flowId !== current.flowId || status.revision <= current.revision)) {
      return
    }
    this.status = status
    this.onChange()
  }

  private async deliverCancel(): Promise<void> {
    const flowId = this.status?.flowId
    if (!flowId || this.cancelDelivered) {
      return
    }
    this.advance(await this.transport.cancel({ flowId }))
    this.cancelDelivered = true
  }

  private async follow(): Promise<TStatus> {
    const { transport } = this
    if (this.cancelRequested) {
      throw new Error(transport.cancelledText)
    }
    // Why retrying is safe: the host answers a repeated start with this owner's running flow.
    this.advance(
      await retryLostAnswers(
        () =>
          transport.start({
            provider: this.provider,
            ...(this.accountId ? { accountId: this.accountId } : {})
          }),
        transport.isLostAnswer
      )
    )
    this.following = true
    const promptDeadline = Date.now() + PROMPT_DEADLINE_MS
    for (;;) {
      const status = this.status
      if (!status || HOST_ACCOUNT_SIGN_IN_SETTLED_PHASES.has(status.phase)) {
        return this.settle()
      }
      if (status.phase === 'starting' && !this.cancelRequested && Date.now() >= promptDeadline) {
        await this.deliverCancel().catch(() => {})
        // A sign-in the host finished meanwhile still wins.
        if (this.status?.phase === 'signedIn') {
          return this.status
        }
        throw new Error(transport.failureText({ ...status, errorCode: 'noPrompt' }))
      }
      if (this.cancelRequested && !this.cancelDelivered) {
        // Why not fatal: an undelivered cancel is asked again after the next answer.
        await this.deliverCancel().catch(() => {})
        if (this.cancelDelivered) {
          continue
        }
      }
      await this.waitOnce(status, promptDeadline)
    }
  }

  private async waitOnce(status: TStatus, promptDeadline: number): Promise<void> {
    const { transport } = this
    const request = (timeoutMs: number) =>
      transport.wait({ flowId: status.flowId, afterRevision: status.revision }, timeoutMs)
    if (status.phase === 'starting' && !this.cancelRequested) {
      // A link wait never outlives the deadline: each try gets only the time left, and once it passes a
      // lost answer ends here as no link.
      const untilDeadline = Math.max(0, promptDeadline - Date.now())
      this.advance(
        await retryLostAnswers(
          () => request(Math.max(1, Math.min(WAIT_TIMEOUT_MS, promptDeadline - Date.now()))),
          transport.isLostAnswer,
          untilDeadline
        ).catch((error: unknown) => {
          if (!transport.isLostAnswer(error)) {
            throw error
          }
          return status
        })
      )
      return
    }
    try {
      this.advance(await request(WAIT_TIMEOUT_MS))
    } catch (error) {
      // Why ask again for as long as the host keeps the flow: the person is on the sign-in page, where a
      // phone is suspended and loses its waits. A cancelled run stops sooner.
      // A cancel's answer may have settled the flow while this wait was out; that outcome stands.
      if (this.status && HOST_ACCOUNT_SIGN_IN_SETTLED_PHASES.has(this.status.phase)) {
        return
      }
      const now = Date.now()
      if (
        !transport.isLostAnswer(error) ||
        now >= this.cancelGiveUpAt ||
        now - this.answeredAt >= HOST_ACCOUNT_SIGN_IN_OWNER_SILENCE_MS
      ) {
        throw error
      }
      const backoff = Math.min(MAX_RETRY_DELAY_MS, RETRY_DELAY_MS * 2 ** this.lostInARow)
      this.lostInARow += 1
      await new Promise((resolve) => setTimeout(resolve, backoff))
    }
  }

  private settle(): TStatus {
    const status = this.status
    // Why signedIn wins over a cancel: the host already saved the account, so say so.
    if (status?.phase === 'signedIn') {
      return status
    }
    if (this.cancelRequested || status?.phase === 'cancelled' || !status) {
      throw new Error(this.transport.cancelledText)
    }
    throw new Error(this.transport.failureText(status))
  }
}
