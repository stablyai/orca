const REMOTE_GIT_RUNTIME_METHODS = new Set([
  'git.fetch',
  'git.forkSync',
  'git.push',
  'git.pull',
  'git.fastForward',
  'git.rebaseFromBase'
])

const TIMEOUT_MESSAGE = 'Timed out waiting for the remote Orca runtime to respond.'

export class RuntimeRpcActionDeadline {
  private readonly startedAtMs = performance.now()
  private expiresAtMs: number | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly boundary: Promise<never>
  private rejectBoundary!: (error: Error) => void

  constructor(timeoutMs?: number) {
    this.expiresAtMs = timeoutMs ? this.startedAtMs + timeoutMs : undefined
    this.boundary = new Promise<never>((_resolve, reject) => {
      this.rejectBoundary = reject
    })
    this.schedule()
  }

  remainingMs(): number | undefined {
    if (this.expiresAtMs === undefined) {
      return undefined
    }
    const remaining = Math.ceil(this.expiresAtMs - performance.now())
    if (remaining <= 0) {
      throw new Error(TIMEOUT_MESSAGE)
    }
    return remaining
  }

  boundedPhaseMs(requested?: number): number | undefined {
    const remaining = this.remainingMs()
    if (requested === undefined) {
      return remaining
    }
    return remaining === undefined ? requested : Math.min(requested, remaining)
  }

  applyConfiguredTimeout(timeoutMs: number | undefined): void {
    if (!Number.isSafeInteger(timeoutMs) || !timeoutMs || timeoutMs < 1) {
      return
    }
    this.expiresAtMs = Math.min(
      this.expiresAtMs ?? Number.POSITIVE_INFINITY,
      this.startedAtMs + timeoutMs
    )
    this.schedule()
  }

  run<T>(call: Promise<T>): Promise<T> {
    return Promise.race([call, this.boundary])
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer)
    }
  }

  private schedule(): void {
    if (this.timer) {
      clearTimeout(this.timer)
    }
    if (this.expiresAtMs === undefined) {
      this.timer = undefined
      return
    }
    this.timer = setTimeout(
      () => this.rejectBoundary(new Error(TIMEOUT_MESSAGE)),
      Math.max(0, this.expiresAtMs - performance.now())
    )
  }
}

export function isRemoteGitRuntimeMethod(method: string): boolean {
  return REMOTE_GIT_RUNTIME_METHODS.has(method)
}

export function withRuntimeGitOperationTimeout(
  method: string,
  params: unknown,
  timeoutMs: number | undefined
): unknown {
  if (!isRemoteGitRuntimeMethod(method)) {
    return params
  }
  return {
    ...(params && typeof params === 'object' && !Array.isArray(params) ? params : {}),
    ...(timeoutMs === undefined ? {} : { operationTimeoutMs: timeoutMs })
  }
}
