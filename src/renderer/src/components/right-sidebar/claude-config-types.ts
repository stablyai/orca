export type AgentItem = {
  name: string
  description: string
  filePath: string
  relativePath: string
  model?: string
  tools?: string
}

export type SkillItem = {
  name: string
  description: string
  filePath: string
  relativePath: string
}

export type CommandItem = {
  name: string
  description: string
  filePath: string
  relativePath: string
}

export type RuleItem = {
  name: string
  description: string
  filePath: string
  relativePath: string
  paths?: string[]
}

export type McpServerItem = {
  name: string
  description: string
  filePath: string
  relativePath: string
  type: 'http' | 'stdio'
  url?: string
  command?: string
}

export type ClaudeConfig = {
  agents: AgentItem[]
  skills: SkillItem[]
  commands: CommandItem[]
  rules: RuleItem[]
  mcpServers: McpServerItem[]
}

export const EMPTY_CONFIG: ClaudeConfig = {
  agents: [],
  skills: [],
  commands: [],
  rules: [],
  mcpServers: []
}
