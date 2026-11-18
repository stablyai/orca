// Tests' stand-in for this app's own host answering `bots.slack/linear/github/connect.*`: each method
// goes to the matching fake on `api.botSlack`, `api.botLinear` or `api.botGitHub`, read at call time,
// so a test that re-mocks one later is followed. A trip's `connect` fake resolves with the trip's end.
type Fake = (args?: unknown) => unknown
type FakeService = Partial<Record<string, Fake>>
type FakeApi = {
  botSlack?: FakeService
  botLinear?: FakeService
  botGitHub?: FakeService
  runtime?: { call?: (args: { method: string; params?: unknown }) => unknown }
  shell?: { openUrl?: (url: string) => unknown }
  // The rest of the window API a test fakes, kept as given.
  [other: string]: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isConnectorMethod = (method: string): boolean =>
  ['bots.slack.', 'bots.linear.', 'bots.github.', 'bots.connect.'].some((prefix) =>
    method.startsWith(prefix)
  )

/** Adds `runtime.call` (and a no-op `shell.openUrl`, unless one is given) answering from the fakes. */
export function withBotConnectorRuntime<T extends FakeApi>(api: T): T {
  const previous = api.runtime?.call
  const trips = new Map<string, Promise<unknown>>()
  let tripsStarted = 0
  const service = (name: unknown): FakeService | undefined =>
    name === 'slack'
      ? api.botSlack
      : name === 'linear'
        ? api.botLinear
        : name === 'github'
          ? api.botGitHub
          : undefined
  const answer = async (method: string, params: unknown): Promise<unknown> => {
    const [, group, name] = method.split('.')
    const field = (key: string): unknown => (isRecord(params) ? params[key] : undefined)
    if (group === 'connect') {
      const trip = service(field('source'))
      if (name === 'start') {
        const id = `00000000-0000-4000-8000-${String(++tripsStarted).padStart(12, '0')}`
        trips.set(id, Promise.resolve(trip?.connect?.({ switchAccount: field('switchAccount') })))
        return { ok: true, value: { tripId: id, authorizeUrl: 'https://connect.example.test/' } }
      }
      if (name === 'wait') {
        return { state: 'done', result: await trips.get(String(field('tripId'))) }
      }
      if (name === 'cancel') {
        await trip?.cancelConnect?.()
        return { cancelled: true }
      }
      return trip?.redeem?.({ result: field('result') })
    }
    const fn = service(group)?.[name]
    if (!fn) {
      throw new Error(`No fake for ${method}`)
    }
    return params === undefined ? fn() : fn(params)
  }
  api.runtime = {
    ...api.runtime,
    call: async ({ method, params }) =>
      isConnectorMethod(method)
        ? { ok: true, result: await answer(method, params) }
        : previous?.({ method, params })
  }
  api.shell = { openUrl: () => undefined, ...api.shell }
  return api
}
