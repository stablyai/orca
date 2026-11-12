import type { AgentSessionExecutionPolicy } from './agent-session-execution-policy'
import type { AgentSessionExecutionExecutable } from './agent-session-execution-evidence'
import type { AgentSessionExecutionReceipt } from './agent-session-execution-receipt'

export type AgentSessionExecutionQualification = {
  runtime: { runtimeId: string; pid: number; buildHash: string }
  policy: AgentSessionExecutionPolicy
  receipt: Omit<AgentSessionExecutionReceipt, 'spawnTokenHash'>
  metadata: {
    executable: AgentSessionExecutionExecutable
    observedAt: number
    account: { fingerprint: string; plan: string }
    limits: { bucket: string; remaining: number; resetAt: number }[]
    catalog: { model: string; efforts: string[] }[]
  } | null
}
