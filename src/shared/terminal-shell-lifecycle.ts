import type { ExecutionHostId } from './execution-host'

export type ShellLifecycleObservation = {
  confidence: 'cooperative' | 'none'
  phase: 'prompt' | 'running' | 'unknown'
  source: 'managed-bash' | 'none'
  reason: string
  generation: number | null
  signalAgeMs: number | null
}

export type HostShellLifecycleObservation = ShellLifecycleObservation & {
  ptyIncarnationId: string
  authorityGeneration: string
}

export type RuntimeTerminalShellLifecycle = ShellLifecycleObservation & {
  runtimeId: string | null
  executionHostId: ExecutionHostId | null
  ptyId: string | null
  incarnationId: string | null
  authorityGeneration: string | null
  observedAt: number
}
