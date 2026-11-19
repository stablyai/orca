export type AgentSessionHook = {
  key: string
  currentHash: string
  command?: string
  handlerType: string
  eventName: string
  matcher?: string | null
  source: string
  sourcePath: string
  enabled: boolean
  isManaged: boolean
  trustStatus: 'managed' | 'untrusted' | 'trusted' | 'modified'
  timeoutSec: number
  async?: boolean
}

export type AgentSessionHookTrust = {
  scope: string
  key: string
  currentHash: string
}

export type AgentSessionHooks = {
  scope: string
  cwd: string
  live: boolean
  hooks: AgentSessionHook[]
  warnings: string[]
}
