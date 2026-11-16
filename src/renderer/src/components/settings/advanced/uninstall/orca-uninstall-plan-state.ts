import {
  ORCA_UNINSTALL_STEPS,
  type OrcaUninstallAgentEntry,
  type OrcaUninstallEntryState,
  type OrcaUninstallHostEntry,
  type OrcaUninstallPlan,
  type OrcaUninstallRunStepArgs,
  type OrcaUninstallStep
} from '../../../../../../shared/uninstall/orca-uninstall-types'

export function isOrcaUninstallProblem(state: OrcaUninstallEntryState): boolean {
  return state === 'error' || state === 'needs-user'
}

export function getOrcaUninstallStepStates(
  plan: OrcaUninstallPlan,
  step: OrcaUninstallStep
): OrcaUninstallEntryState[] {
  switch (step) {
    case 'agent-hooks':
      return plan.agents.map((entry) => entry.state)
    case 'cli-command':
      return plan.cliCommand ? [plan.cliCommand.state] : []
    case 'background-service':
      return plan.backgroundService ? [plan.backgroundService.state] : []
    case 'hook-scripts':
      return plan.hookScripts ? [plan.hookScripts.state] : []
    case 'ssh-hosts':
      return plan.hosts.map((entry) => entry.state)
  }
}

export function countOrcaUninstallProblems(plan: OrcaUninstallPlan): number {
  return ORCA_UNINSTALL_STEPS.flatMap((step) => getOrcaUninstallStepStates(plan, step)).filter(
    isOrcaUninstallProblem
  ).length
}

/** Kept for a reason that can still clear (an agent that failed), not because another Orca build uses it. */
export function countOrcaUninstallPendingKept(plan: OrcaUninstallPlan): number {
  if (plan.otherOrcaBuildName) {
    return 0
  }
  return ORCA_UNINSTALL_STEPS.flatMap((step) => getOrcaUninstallStepStates(plan, step)).filter(
    (state) => state === 'kept-shared'
  ).length
}

/** The scripts stay while any agent still runs them; once a retry clears the last agent they can go. */
export function shouldRemoveHookScriptsAfterAgentRetry(plan: OrcaUninstallPlan): boolean {
  return (
    plan.otherOrcaBuildName === null &&
    plan.hookScripts !== null &&
    plan.hookScripts.state !== 'removed' &&
    plan.agents.every((entry) => entry.state === 'removed' || entry.state === 'kept-shared')
  )
}

// An entry the step ran on but the returned plan no longer lists is gone from disk.
function mergeById<T extends { state: OrcaUninstallEntryState }>(
  previous: T[],
  next: T[],
  idOf: (entry: T) => string,
  only: readonly string[] | undefined
): T[] {
  const nextById = new Map(next.map((entry) => [idOf(entry), entry]))
  return previous.map((entry) => {
    const id = idOf(entry)
    if (only && !only.includes(id)) {
      return entry
    }
    return nextById.get(id) ?? { ...entry, state: 'removed' }
  })
}

function mergeSimple<T extends { state: OrcaUninstallEntryState }>(
  previous: T | null,
  next: T | null
): T | null {
  if (!previous) {
    return null
  }
  return next ?? { ...previous, state: 'removed' }
}

const agentId = (entry: OrcaUninstallAgentEntry): string => entry.agent
const hostId = (entry: OrcaUninstallHostEntry): string => entry.hostId

/** Takes only the entries the step ran on, so a backend rescan can't drop rows the user is reading. */
export function mergeOrcaUninstallStepResult(
  previous: OrcaUninstallPlan,
  next: OrcaUninstallPlan,
  { step, only }: OrcaUninstallRunStepArgs
): OrcaUninstallPlan {
  switch (step) {
    case 'agent-hooks':
      return { ...previous, agents: mergeById(previous.agents, next.agents, agentId, only) }
    case 'cli-command':
      return { ...previous, cliCommand: mergeSimple(previous.cliCommand, next.cliCommand) }
    case 'background-service':
      return {
        ...previous,
        backgroundService: mergeSimple(previous.backgroundService, next.backgroundService)
      }
    case 'hook-scripts':
      return { ...previous, hookScripts: mergeSimple(previous.hookScripts, next.hookScripts) }
    case 'ssh-hosts':
      return { ...previous, hosts: mergeById(previous.hosts, next.hosts, hostId, only) }
  }
}

export function markOrcaUninstallStepFailed(
  plan: OrcaUninstallPlan,
  { step, only }: OrcaUninstallRunStepArgs,
  detail: string
): OrcaUninstallPlan {
  const fail = <T extends { state: OrcaUninstallEntryState; detail: string | null }>(
    entry: T
  ): T => ({ ...entry, state: 'error', detail })
  const failListed = <T extends { state: OrcaUninstallEntryState; detail: string | null }>(
    entries: T[],
    idOf: (entry: T) => string
  ): T[] => entries.map((entry) => (only && !only.includes(idOf(entry)) ? entry : fail(entry)))
  switch (step) {
    case 'agent-hooks':
      return { ...plan, agents: failListed(plan.agents, agentId) }
    case 'cli-command':
      return { ...plan, cliCommand: plan.cliCommand && fail(plan.cliCommand) }
    case 'background-service':
      return { ...plan, backgroundService: plan.backgroundService && fail(plan.backgroundService) }
    case 'hook-scripts':
      return { ...plan, hookScripts: plan.hookScripts && fail(plan.hookScripts) }
    case 'ssh-hosts':
      return { ...plan, hosts: failListed(plan.hosts, hostId) }
  }
}

/** Runs one step and folds its result into the plan; a thrown step marks its own rows as errors. */
async function runOrcaUninstallStep(
  plan: OrcaUninstallPlan,
  args: OrcaUninstallRunStepArgs,
  runStep: (args: OrcaUninstallRunStepArgs) => Promise<OrcaUninstallPlan>,
  failureDetail: string
): Promise<OrcaUninstallPlan> {
  try {
    return mergeOrcaUninstallStepResult(plan, await runStep(args), args)
  } catch (error) {
    console.error(`[uninstall] step ${args.step} failed:`, error)
    return markOrcaUninstallStepFailed(plan, args, failureDetail)
  }
}

/** Runs every step the plan has entries for, in order; one failed step doesn't stop the rest. */
export async function runOrcaUninstallSteps(
  initial: OrcaUninstallPlan,
  runStep: (args: OrcaUninstallRunStepArgs) => Promise<OrcaUninstallPlan>,
  failureDetail: string,
  onProgress: (plan: OrcaUninstallPlan, runningStep: OrcaUninstallStep | null) => void
): Promise<OrcaUninstallPlan> {
  let plan = initial
  for (const step of ORCA_UNINSTALL_STEPS) {
    if (getOrcaUninstallStepStates(plan, step).length === 0) {
      continue
    }
    onProgress(plan, step)
    plan = await runOrcaUninstallStep(plan, { step }, runStep, failureDetail)
  }
  onProgress(plan, null)
  return plan
}
