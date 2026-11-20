/** Discovery evidence from the answering runtime; never confirms a Dispatch's execution. */
export type WorkerExecutionTarget = { kind: 'native' | 'wsl' | 'unknown' }
