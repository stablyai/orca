export type Gate = {
  wait: Promise<void>
  release: () => void
  fail: (error: unknown) => void
}

export function createGate(): Gate {
  let release!: () => void
  let fail!: (error: unknown) => void
  const wait = new Promise<void>((resolve, reject) => {
    release = () => resolve()
    fail = (error: unknown) => reject(error)
  })
  // Why: the gate is released by the test, not by this tick; an unhandled rejection would fail the run.
  wait.catch(() => {})
  return { wait, release, fail }
}

export function rpcError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}
