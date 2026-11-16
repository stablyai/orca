// Turns the Droid probe hook logs (src/shared/__fixtures__/droid-*-hooks.jsonl, provenance in the
// matching .meta.json) into the hooks a listener sees. A log names sessions by per-run relation
// (S1, S2) and records no pid, so this module gives each its concrete value. The only invented
// hook is the opt-in first prompt for a pane, because the probes never typed one at startup.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentProcessIdentity } from '../../../agent-status/process/agent-process-presence'

export type DroidProbeFixture =
  | 'droid-parent-process-hooks'
  | 'droid-subagent-hooks'
  | 'droid-slow-start-hooks'

type LogRow = {
  run: string
  event: string
  session?: string
  calling?: string
  previous?: string
  source?: string
  reason?: string
  tool?: string
  atMs?: number
  capture?: { platform: AgentProcessIdentity['platform']; startTime: string }
}

export type ReplayHook = {
  /** The log's own words, for failure messages: `SessionEnd S1 other`. */
  label: string
  payload: Record<string, unknown>
  process: AgentProcessIdentity
  /** Milliseconds since the run's first hook, for the logs that have a clock. */
  atMs: number | null
}

export type ReplayRun = {
  name: string
  identity: AgentProcessIdentity
  hooks: ReplayHook[]
  /** The session id a log relation (`S2`) stands for in this run. */
  id: (relation: string) => string
}

export const REPLAYED_PROMPT = 'replayed prompt'

function readRows(fixture: DroidProbeFixture): LogRow[] {
  return readFileSync(join(__dirname, '../../../__fixtures__', `${fixture}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((line): LogRow => JSON.parse(line))
}

export type ReplayOptions = {
  /** Adds a `UserPromptSubmit` for the first lead, because the probes never sent a prompt. */
  promptForFirstLead?: boolean
}

export function loadDroidProbeRuns(
  fixture: DroidProbeFixture,
  options: ReplayOptions = {}
): ReplayRun[] {
  const groups = new Map<string, LogRow[]>()
  for (const row of readRows(fixture)) {
    groups.set(row.run, [...(groups.get(row.run) ?? []), row])
  }
  return [...groups.entries()].map(([name, rows], index) => buildRun(name, rows, index, options))
}

function buildRun(name: string, rows: LogRow[], index: number, options: ReplayOptions): ReplayRun {
  const capture = rows.find((row) => row.capture)?.capture
  const identity: AgentProcessIdentity = {
    pid: 90_000 + index,
    platform: capture?.platform ?? 'darwin',
    startTime: capture?.startTime ?? `replayed process ${index}`
  }
  const id = (relation: string): string => {
    const number = /^S(\d+)$/.exec(relation)?.[1]
    if (!number) {
      throw new Error(`Not a probe relation: ${relation}`)
    }
    return `s${number.padStart(7, '0')}-${String(index).padStart(4, '0')}-4000-8000-000000000000`
  }
  const hooks: ReplayHook[] = []
  // A log that already holds a prompt needs none added.
  let prompted = rows.some((row) => row.event === 'UserPromptSubmit')
  for (const row of rows) {
    hooks.push(hookOf(row, identity, id))
    if (options.promptForFirstLead && !prompted && row.event === 'SessionStart') {
      prompted = true
      if (row.session && !row.calling) {
        hooks.push({
          label: `UserPromptSubmit ${row.session} (replay adds)`,
          payload: {
            hook_event_name: 'UserPromptSubmit',
            session_id: id(row.session),
            prompt: REPLAYED_PROMPT
          },
          process: identity,
          atMs: row.atMs ?? null
        })
      }
    }
  }
  return { name, identity, hooks, id }
}

function hookOf(
  row: LogRow,
  identity: AgentProcessIdentity,
  id: (relation: string) => string
): ReplayHook {
  return {
    label: [row.event, row.session, row.source, row.reason].filter(Boolean).join(' '),
    payload: {
      hook_event_name: row.event,
      ...(row.session ? { session_id: id(row.session) } : {}),
      ...(row.source ? { source: row.source } : {}),
      ...(row.reason ? { reason: row.reason } : {}),
      ...(row.calling ? { calling_session_id: id(row.calling) } : {}),
      ...(row.previous ? { previous_session_id: id(row.previous) } : {}),
      ...(row.tool ? { tool_name: row.tool, tool_input: {} } : {}),
      ...(row.event === 'UserPromptSubmit' ? { prompt: REPLAYED_PROMPT } : {})
    },
    process: identity,
    atMs: row.atMs ?? null
  }
}

/** The `SessionEnd other` hooks that arrive before the SessionStart that replaces their session. */
export function invertedSessionEnds(run: ReplayRun): ReplayHook[] {
  return run.hooks.filter((hook, index) => {
    const next = run.hooks[index + 1]?.payload
    return (
      hook.payload.hook_event_name === 'SessionEnd' &&
      hook.payload.reason === 'other' &&
      next?.hook_event_name === 'SessionStart' &&
      next.source === 'resume' &&
      next.session_id !== hook.payload.session_id
    )
  })
}
