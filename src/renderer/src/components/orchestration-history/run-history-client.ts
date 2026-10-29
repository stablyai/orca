import { z } from 'zod'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/runtime-client-target'
import { RunEventsPageSchema } from '../../../../shared/orchestration-run-events'

const RunSchema = z.object({
  id: z.string(),
  objective: z.string(),
  created_at: z.string()
})
const RunListSchema = z.object({
  runs: z.array(RunSchema),
  nextCursor: z.string().nullable().optional().default(null)
})

export type HistoryRun = z.infer<typeof RunSchema>

export async function loadHistoryRuns(
  environmentId: string | null,
  cursor: string | undefined,
  signal: AbortSignal
) {
  const page = RunListSchema.parse(
    await callRuntimeRpc<unknown>(
      runtimeTargetForOwnerEnvironment(environmentId),
      'orchestration.runList',
      { limit: 50, ...(cursor ? { cursor } : {}) },
      { signal, timeoutMs: 15_000 }
    )
  )
  return { rows: page.runs, nextCursor: page.nextCursor }
}

export async function loadHistoryEvents(
  environmentId: string | null,
  runId: string,
  cursor: string | undefined,
  signal: AbortSignal
) {
  const page = RunEventsPageSchema.parse(
    await callRuntimeRpc<unknown>(
      runtimeTargetForOwnerEnvironment(environmentId),
      'orchestration.runEvents',
      { id: runId, limit: 100, ...(cursor ? { cursor } : {}) },
      { signal, timeoutMs: 15_000 }
    )
  )
  if (page.runId !== runId || page.events.some((event) => event.runId !== runId)) {
    throw new Error('Run history does not match the requested Run')
  }
  return { rows: page.events, nextCursor: page.nextCursor, coverage: page.coverage }
}
