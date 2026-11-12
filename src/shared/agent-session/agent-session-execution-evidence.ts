/** Native facts about one held child; evidence alone does not qualify a route. */
export type AgentSessionExecutionEvidence = {
  version: 1
  agent: 'codex'
  modelProvider: 'openai'
  sessionId: string
  runtimeFence: number
  acquisitionGeneration: string
  observedAt: number
  cwd: string
  model: string
  effort: string
  account: { type: 'chatgpt'; fingerprint: string; plan: string }
  permissions: {
    approvalPolicy: string
    approvalsReviewer: string
    sandbox: {
      type: 'readOnly' | 'workspaceWrite'
      networkAccess: false
      readableRoots: string[]
      writableRoots: string[]
      includePlatformDefaults: boolean
    }
  }
}
