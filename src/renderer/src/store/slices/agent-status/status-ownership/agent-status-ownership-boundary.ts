import type { StateCreator } from 'zustand'
import type { AppState } from '../../../types'
import type { StoreSetArgs } from '../../../diagnostics/react-commit-cascade-write-probe'

/** Outermost policy: finish transformations and getters before publishing mutable keyed owners. */
export function withAgentStatusOwnership(
  createState: StateCreator<AppState, [], []>
): StateCreator<AppState, [], []> {
  return (set, get, api) => {
    const subscribe = api.subscribe
    api.subscribe = (listener) =>
      subscribe((...args) => {
        try {
          listener(...args)
        } catch (error) {
          console.error('Store observer failed', error)
        }
      })
    const wrap =
      (write: typeof set): typeof set =>
      (...args: StoreSetArgs<AppState>): void => {
        const current = get()
        const requested = typeof args[0] === 'function' ? args[0](current) : args[0]
        if (requested === current) {
          return
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Zustand's replace overload requires a complete state; merged writes inherit all other fields.
        const next = { ...(args[1] === true ? {} : get()), ...requested } as AppState
        const fullResync = !next.agentStatusByPaneKey.sharesOwner(current.agentStatusByPaneKey)
        if (fullResync) {
          const incoming = next.agentStatusByPaneKey
          next.agentStatusByPaneKey = current.agentStatusByPaneKey.replace([
            ...Array.from(current.agentStatusByPaneKey.keys(), (key) => [key, null] as const),
            ...incoming
          ])
        }
        const statuses = next.agentStatusByPaneKey
        const publishStatuses = statuses.prepare()
        const publishProjection = statuses.projection.prepare(
          next,
          statuses.changes(),
          statuses.refreshKeys,
          fullResync
        )
        publishProjection()
        publishStatuses()
        {
          const g = globalThis as unknown as {
            __orcaDispatch?: {
              depth: number
              child: number[]
              timings: { kind: string; ms: number }[]
            }
          }
          const d = (g.__orcaDispatch ??= { depth: 0, child: [0], timings: [] })
          const keys = Object.keys(requested).filter(
            (key) =>
              !Object.is(
                (current as unknown as Record<string, unknown>)[key],
                (next as unknown as Record<string, unknown>)[key]
              )
          )
          const kind = keys.includes('agentStatusByPaneKey')
            ? 'agent-status'
            : keys.includes('runtimeStatusByEnvironmentId')
              ? 'host-status'
              : 'other'
          d.depth += 1
          d.child.push(0)
          const started = performance.now()
          try {
            write(next, true)
          } finally {
            const total = performance.now() - started
            const nested = d.child.pop() ?? 0
            d.depth -= 1
            d.child[d.child.length - 1] += total
            if (d.timings.length < 50_000) {
              d.timings.push({ kind, ms: total - nested })
            }
          }
        }
        statuses.projection.notify()
      }
    api.setState = wrap(api.setState)
    const state = createState(wrap(set), get, api)
    state.agentStatusByPaneKey.projection.prepare(state, [])()
    const initial = captureAgentStatusView(state)
    api.getInitialState = () => initial
    return state
  }
}

export function captureAgentStatusView(state: AppState): AppState {
  const captured = { ...state, agentStatusByPaneKey: state.agentStatusByPaneKey.capture() }
  return captured
}
