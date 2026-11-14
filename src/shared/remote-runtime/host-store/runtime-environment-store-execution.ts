let inline = false
let sealed = false
let drain: (() => Promise<void>) | undefined

/** The CLI bootstrap stays independent of the store graph until an operation needs it. */
export function useInlineEnvironmentStoreForCli(): void {
  if (inline || sealed) {
    throw new Error('Environment store placement is already sealed')
  }
  inline = true
}

export function environmentStoreRunsInline(): boolean {
  return inline
}

export function sealEnvironmentStorePlacement(): void {
  sealed = true
}

export function admitEnvironmentStoreOperation(close: () => Promise<void>): void {
  sealed = true
  drain ??= close
}

export function closeAdmittedEnvironmentStore(): Promise<void> {
  return drain?.() ?? Promise.resolve()
}
