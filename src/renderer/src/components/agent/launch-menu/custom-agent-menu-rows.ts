import type { NewTabAgentMenuRow } from '../../../../../shared/agent-launch/picker/agent-launch-picker-rows'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { CustomTuiAgent } from '../../../../../shared/agent-launch/catalog/custom-tui-agents'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'

/** The menu row that launches a custom agent: its base agent in a terminal, with its own command. */
export function customAgentMenuRow(
  custom: CustomTuiAgent,
  rows: readonly NewTabAgentMenuRow[]
): NewTabAgentMenuRow {
  const executionHostId = rows.find((row) => row.agent === custom.agent)?.executionHostId
  return {
    kind: 'cli',
    agent: custom.agent,
    custom,
    ...(executionHostId ? { executionHostId } : {})
  }
}

/** Custom agents whose base agent this local workspace's host can run (all while detection is pending). */
export function launchableCustomAgents(
  customAgents: readonly CustomTuiAgent[] | undefined,
  detectedIds: readonly TuiAgent[] | null,
  rows: readonly NewTabAgentMenuRow[] = []
): CustomTuiAgent[] {
  // Custom agents live in local desktop settings; never offer them on remote execution hosts.
  if (rows.some((row) => row.executionHostId && row.executionHostId !== LOCAL_EXECUTION_HOST_ID)) {
    return []
  }
  return (customAgents ?? []).filter(
    (custom) => detectedIds === null || detectedIds.includes(custom.agent)
  )
}
