export type DecisionSource<T> = {
  id: string
  state: string
  summary?: string
  since: number
  value: T
}

export type DecisionGroup<T> = {
  id: string
  summary: string
  requests: DecisionSource<T>[]
}

/** Group for display only. Each request keeps its original destination and approval context. */
export function groupPendingDecisions<T>(sources: DecisionSource<T>[]): DecisionGroup<T>[] {
  const groups = new Map<string, DecisionGroup<T>>()
  for (const source of sources) {
    const summary = source.summary?.trim() ?? ''
    if (source.state !== 'blocked' && !(source.state === 'waiting' && summary)) {
      continue
    }
    const id = summary ? `prompt:${summary}` : `source:${source.id}`
    const group = groups.get(id)
    if (group) {
      group.requests.push(source)
    } else {
      groups.set(id, { id, summary, requests: [source] })
    }
  }
  const ordered = [...groups.values()]
  for (const group of ordered) {
    group.requests.sort((a, b) => a.since - b.since || a.id.localeCompare(b.id))
  }
  return ordered.sort(
    (a, b) =>
      b.requests.length - a.requests.length ||
      a.requests[0]!.since - b.requests[0]!.since ||
      a.id.localeCompare(b.id)
  )
}
