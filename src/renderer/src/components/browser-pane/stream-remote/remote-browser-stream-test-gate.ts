export type Gate = {
  wait: Promise<void>
  release: () => void
  fail: (error: unknown) => void
}

export function createGate(): Gate {
  let release!: () => void
  let fail!: (error: unknown) => void
  const wait = new Promise<void>((resolve, reject) => {
    release = resolve
    fail = reject
  })
  wait.catch(() => {})
  return { wait, release, fail }
}

export class RemoteBrowserRecoveryEvalGate {
  private gate: Gate | null = null
  signal: AbortSignal | null = null
  abortCount = 0

  hold(): Gate {
    this.gate = createGate()
    return this.gate
  }

  async wait(signal?: AbortSignal): Promise<void> {
    if (!this.gate) {
      return
    }
    const gate = this.gate
    this.gate = null
    this.signal = signal ?? null
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        this.abortCount += 1
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      gate.wait.then(resolve, reject).finally(() => signal?.removeEventListener('abort', onAbort))
      if (signal?.aborted) {
        onAbort()
      }
    })
  }
}
