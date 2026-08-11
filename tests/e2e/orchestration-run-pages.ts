import { ORCHESTRATION_RUN_PAGE_LIMIT } from '../../src/shared/orchestration-run-pagination'

export type OrchestrationRunSummary = {
  id: string
  objective: string
}

type RunListClient = {
  call<TResult>(method: string, params?: unknown): Promise<{ result: TResult }>
}

export async function listAllOrchestrationRuns(
  client: RunListClient
): Promise<OrchestrationRunSummary[]> {
  const runs: OrchestrationRunSummary[] = []
  let cursor: string | undefined
  do {
    const page = await client.call<{
      runs: OrchestrationRunSummary[]
      nextCursor?: string | null
    }>('orchestration.runList', {
      limit: ORCHESTRATION_RUN_PAGE_LIMIT,
      ...(cursor ? { cursor } : {})
    })
    runs.push(...page.result.runs)
    cursor = page.result.nextCursor ?? undefined
  } while (cursor)
  return runs
}
