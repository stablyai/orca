/** Transport to a runtime: this app (local or direct SSH), or a paired server's environment. */
export type RuntimeClientTarget = { kind: 'local' } | { kind: 'environment'; environmentId: string }
