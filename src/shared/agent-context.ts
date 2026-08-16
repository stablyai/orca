import type { AgentType } from './agent-status-types'
import type { McpConfigInspection } from './mcp-config'
import type { SkillDiscoveryTarget } from './skills'

/** Where a context source sits relative to the workspace. */
export type AgentContextScope = 'home' | 'project' | 'ancestor'

/**
 * One instruction file an agent loads at session start (CLAUDE.md, AGENTS.md,
 * GEMINI.md, .cursorrules, …). `agents` lists every agent that reads the file;
 * shared files (AGENTS.md) carry several.
 */
export type AgentContextInstructionFile = {
  id: string
  label: string
  /** Host-native display path (POSIX for WSL/SSH targets). */
  path: string
  scope: AgentContextScope
  agents: AgentType[]
  exists: boolean
  sizeBytes: number | null
  updatedAt: number | null
  /** Directory sources (e.g. `.cursor/rules/`) report how many rule files they hold. */
  entryCount?: number
}

export type AgentContextMcpFile = {
  id: string
  /** Host-native display path. */
  path: string
  scope: AgentContextScope
  agents: AgentType[]
  inspection: McpConfigInspection
}

export type AgentContextHookFile = {
  id: string
  path: string
  scope: AgentContextScope
  agents: AgentType[]
  exists: boolean
  /** Hook event names declared in the file, e.g. `PreToolUse`. */
  events: string[]
  /** Total hook entries across all events. */
  hookCount: number
  error?: string
}

export type AgentContextPlugin = {
  id: string
  name: string
  agents: AgentType[]
  enabled: boolean
  /** Settings file that decided `enabled`. */
  sourcePath: string
  scope: AgentContextScope
}

export type AgentContextReport = {
  target: {
    kind: 'native-host' | 'wsl'
    distro?: string
    /** Display paths — POSIX for WSL. */
    homeDir: string
    cwd: string | null
  }
  instructionFiles: AgentContextInstructionFile[]
  mcpFiles: AgentContextMcpFile[]
  hookFiles: AgentContextHookFile[]
  plugins: AgentContextPlugin[]
  scannedAt: number
}

/** Same host/workspace addressing as skill discovery: the two always name one host. */
export type AgentContextInspectTarget = SkillDiscoveryTarget
