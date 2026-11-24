import { z } from 'zod'
import {
  ACTIVITY_GROUP_BY_VALUES,
  THREAD_READ_FILTER_VALUES
} from '../../agent-status/presentation/agents-view-thread-filters'

/** Agents view and worker tab preferences in a paired client's UI update. */
export const ClientUiAgentViewFields = {
  agentsShowChildAgents: z.boolean().optional(),
  agentsCompactMode: z.boolean().optional(),
  agentsShowSearch: z.boolean().optional(),
  agentsReadFilter: z.enum(THREAD_READ_FILTER_VALUES).optional(),
  agentsGroupBy: z.enum(ACTIVITY_GROUP_BY_VALUES).optional(),
  workerTabsMode: z.enum(['open-when-clicked', 'always-open']).optional(),
  workerTabHideHintShown: z.boolean().optional()
}
