export type DecisionGateStatus = 'pending' | 'resolved' | 'timeout'

export type DecisionGate = {
  id: string
  task_id: string
  question: string
  options: string
  status: DecisionGateStatus
  resolution: string | null
  created_at: string
  resolved_at: string | null
}
