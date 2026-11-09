import { z } from 'zod'
import { WorktreeSelector } from './git-params'
export const AgentDiscoverTerminalModels = WorktreeSelector.extend({ agentId: z.string().min(1) })
