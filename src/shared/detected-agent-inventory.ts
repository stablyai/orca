import { z } from 'zod'
import { ALL_TUI_AGENTS } from './tui-agent-display-names'
import type { TuiAgent } from './types'

export const DETECTED_AGENT_INVENTORY_VERSION = 1 as const

export type DetectedAgentInventoryV1 = {
  version: 1
  agents: TuiAgent[]
  matchedCommands: Partial<Record<TuiAgent, string>>
}

const knownAgentIds = new Set<string>(ALL_TUI_AGENTS)
const tuiAgentSchema = z
  .string()
  .refine((value) => knownAgentIds.has(value))
  .transform((value) => value as TuiAgent)

export const detectedAgentInventoryRequestSchema = z
  .object({
    version: z.literal(DETECTED_AGENT_INVENTORY_VERSION),
    commands: z
      .array(
        z
          .object({
            id: tuiAgentSchema,
            cmd: z.string().min(1).max(4_096),
            capabilityProbe: z
              .object({
                args: z.array(z.string().max(4_096)).max(8),
                matchedCommand: z.string().min(1).max(4_096)
              })
              .strict()
              .optional(),
            requiredCommands: z.array(z.string().min(1).max(4_096)).max(8).optional(),
            unsupportedRuntimes: z
              .array(
                z.enum([
                  'aix',
                  'android',
                  'darwin',
                  'freebsd',
                  'haiku',
                  'linux',
                  'openbsd',
                  'sunos',
                  'win32',
                  'cygwin',
                  'netbsd',
                  'wsl'
                ])
              )
              .max(16)
              .optional()
          })
          .strict()
      )
      .max(ALL_TUI_AGENTS.length * 4)
  })
  .strict()

export type DetectedAgentInventoryRequestV1 = z.infer<typeof detectedAgentInventoryRequestSchema>

export const detectedAgentInventorySchema = z
  .object({
    version: z.literal(DETECTED_AGENT_INVENTORY_VERSION),
    agents: z.array(tuiAgentSchema).max(ALL_TUI_AGENTS.length),
    matchedCommands: z
      .record(z.string(), z.string().min(1).max(4_096))
      .refine((commands) => Object.keys(commands).every((agent) => knownAgentIds.has(agent)))
      .transform((commands) => commands as Partial<Record<TuiAgent, string>>)
  })
  .strict()

export function emptyDetectedAgentInventory(): DetectedAgentInventoryV1 {
  return { version: DETECTED_AGENT_INVENTORY_VERSION, agents: [], matchedCommands: {} }
}

export function detectedAgentInventory(
  agents: readonly TuiAgent[],
  matchedCommands: Partial<Record<TuiAgent, string>>
): DetectedAgentInventoryV1 {
  return detectedAgentInventorySchema.parse({
    version: DETECTED_AGENT_INVENTORY_VERSION,
    agents: [...new Set(agents)],
    matchedCommands
  })
}

export function legacyDetectedAgentInventory(
  agents: readonly TuiAgent[]
): DetectedAgentInventoryV1 {
  return detectedAgentInventory(agents, agents.includes('cursor') ? { cursor: 'cursor-agent' } : {})
}
