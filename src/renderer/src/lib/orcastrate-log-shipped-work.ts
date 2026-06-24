// Why: a director records its outcomes to `.orcastrate/log.jsonl` in its own
// worktree (so the record is per-director, and survives the workers being torn
// down). This parses that log into the work the director completed — the only
// durable source for a director's shipped history once its worker worktrees are
// gone. The log carries branch names + a one-line plan description + an outcome
// tag, but not PR numbers, so that's what the history can show.

export type OrchestrateOutcomeTag =
  | 'shipped'
  | 'over_split'
  | 'under_split'
  | 'conflict'
  | 'sequencing_miss'
  | 'killed_clean'
  | string

export type ShippedWorkItem = {
  /** Worktree/branch name the director worked under (becomes a PR). */
  name: string
  /** Outcome tag the director logged (`shipped`, `over_split`, …). */
  tag: OrchestrateOutcomeTag
  /** One-line "becomes PR" description from the matching plan record, if any. */
  description?: string
}

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' ? (value as UnknownRecord) : null
}

/**
 * True when an outcome's `ts` parses to a time at/after `sinceMs`. A missing or
 * unparseable `ts` returns false so the outcome is excluded — it can't be
 * attributed to the current director's lifetime.
 */
function isOutcomeWithinLifetime(ts: unknown, sinceMs: number): boolean {
  if (typeof ts !== 'string') {
    return false
  }
  const parsed = Date.parse(ts)
  return !Number.isNaN(parsed) && parsed >= sinceMs
}

/**
 * Parse a director's `.orcastrate/log.jsonl` into its per-worktree outcomes,
 * joining each outcome to its plan description by name. Latest outcome per name
 * wins; unparseable lines are skipped. Order follows first appearance.
 *
 * When `sinceMs` is set, only outcome records whose `ts` parses to a time
 * at/after `sinceMs` contribute. Why: the log is committed to the repo, so a
 * new director worktree (branched from `main`) inherits every prior session's
 * outcomes. Scoping to the director's own lifetime keeps foreign work out of
 * its Shipped view. An outcome with a missing/unparseable `ts` can't be
 * attributed to this director, so it's excluded too (err toward not showing
 * foreign work). Plan records are unscoped — they only supply descriptions.
 */
export function parseOrchestrateLogOutcomes(logText: string, sinceMs?: number): ShippedWorkItem[] {
  const descriptionByName = new Map<string, string>()
  const tagByName = new Map<string, string>()
  const order: string[] = []

  for (const line of logText.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    const record = asRecord(parsed)
    if (!record) {
      continue
    }

    if (record.type === 'plan' && Array.isArray(record.worktrees)) {
      for (const raw of record.worktrees) {
        const wt = asRecord(raw)
        const name = wt?.name
        const becomesPr = wt?.becomes_pr
        if (typeof name === 'string' && typeof becomesPr === 'string') {
          descriptionByName.set(name, becomesPr)
        }
      }
    } else if (record.type === 'outcome' && Array.isArray(record.results)) {
      if (sinceMs !== undefined && !isOutcomeWithinLifetime(record.ts, sinceMs)) {
        continue
      }
      for (const raw of record.results) {
        const result = asRecord(raw)
        const name = result?.name
        const tag = result?.tag
        if (typeof name === 'string' && typeof tag === 'string') {
          if (!tagByName.has(name)) {
            order.push(name)
          }
          tagByName.set(name, tag)
        }
      }
    }
  }

  return order.map((name) => {
    const description = descriptionByName.get(name)
    return {
      name,
      tag: tagByName.get(name) as OrchestrateOutcomeTag,
      ...(description ? { description } : {})
    }
  })
}

/** The director's shipped work — outcomes tagged `shipped`. */
export function selectShippedWork(items: ShippedWorkItem[]): ShippedWorkItem[] {
  return items.filter((item) => item.tag === 'shipped')
}
