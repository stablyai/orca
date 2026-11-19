// A stand-in Orca Cloud for connector actions: it signs the desktop's connector in, holds its polls,
// and answers `connector.act` the way the cloud does over one Slack channel it keeps in memory.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createTlsServer } from 'node:https'

export const ACTIONS_TEAM = 'T0E2E'
export const ACTIONS_CHANNEL = 'C0E2E'
export const ACTIONS_PLACE = `slack:${ACTIONS_TEAM}:${ACTIONS_CHANNEL}`
const FIRST_TS = '1800000000.000100'
export const ACTIONS_FIRST_MESSAGE = `${ACTIONS_PLACE}:${FIRST_TS}:${FIRST_TS}`

export type ActionCall = {
  botId: string
  verb: string
  ref?: string
  args: Record<string, unknown>
}

type Message = { ts: string; author: string; text: string }

export type ConnectorActionsCloud = {
  origin: string
  /** Every `connector.act` the machine sent, in order. */
  actions: ActionCall[]
  helloCount: () => number
  /** When the last poll arrived; a stopped client sends none. */
  lastPollAt: () => number
  /** When (performance.now()) the machine last dropped a poll the cloud was still holding; 0 if never. */
  lastPollDroppedAt: () => number
  /** When (performance.now()) each request arrived, by path. */
  requests: { path: string; at: number }[]
  /** Bot ids the last hello listed; the setup routes refuse any other, as the cloud does. */
  knownBots: () => string[]
  messages: Message[]
  reactions: Set<string>
  /** While on, a poll is held until a delivery arrives instead of answering empty after a second. */
  holdPolls: (on: boolean) => void
  /** Hands the machine a delivery on its next poll, answering a held one at once. */
  deliver: (delivery: unknown) => void
  /** Every ack and event batch the machine sent, and every reply it posted, in order. */
  acks: unknown[]
  events: unknown[]
  replies: unknown[]
  close: () => Promise<void>
}

export type ConnectorActionsCloudOptions = {
  /** Serve HTTPS with this identity, for a host that refuses plain HTTP (a packaged build). */
  tls?: { key: string; cert: string }
}

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null)
      } catch {
        resolve(null)
      }
    })
  })
}

function send(response: ServerResponse, status: number, body?: unknown): void {
  response.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' })
  response.end(body === undefined ? undefined : JSON.stringify(body))
}

function helloBotIds(body: unknown): string[] {
  if (typeof body !== 'object' || body === null || !('bots' in body) || !Array.isArray(body.bots)) {
    return []
  }
  return body.bots.flatMap((bot: unknown) =>
    typeof bot === 'object' && bot !== null && 'id' in bot && typeof bot.id === 'string'
      ? [bot.id]
      : []
  )
}

function isActionCall(body: unknown): body is ActionCall {
  return (
    typeof body === 'object' &&
    body !== null &&
    'botId' in body &&
    typeof body.botId === 'string' &&
    'verb' in body &&
    typeof body.verb === 'string'
  )
}

export async function startConnectorActionsCloud(
  options: ConnectorActionsCloudOptions = {}
): Promise<ConnectorActionsCloud> {
  const actions: ActionCall[] = []
  const acks: unknown[] = []
  const events: unknown[] = []
  const replies: unknown[] = []
  const queued: unknown[] = []
  let wakePoll: (() => void) | null = null
  let holdPolls = false
  const messages: Message[] = [{ ts: FIRST_TS, author: 'Dana', text: 'deploys are failing' }]
  const reactions = new Set<string>()
  let hellos = 0
  let lastPollAt = 0
  let lastPollDroppedAt = 0
  const requests: { path: string; at: number }[] = []
  let knownBots: string[] = []
  let clock = 1_800_000_500
  const view = (message: Message) => ({
    ref: `${ACTIONS_PLACE}:${message.ts}:${message.ts}`,
    label: `${message.author}: ${message.text}`,
    author: message.author,
    text: message.text,
    at: Math.floor(Number(message.ts) * 1000)
  })
  // The cloud's answers for the one channel, already resolved to its ref.
  const act = (call: ActionCall) => {
    const target = { ref: ACTIONS_PLACE, label: '#general' }
    switch (call.verb) {
      case 'capabilities':
        return {
          sources: [
            {
              source: 'slack',
              verbs: Object.fromEntries(
                ['react', 'read', 'post', 'find', 'check'].map((verb) => [
                  verb,
                  { status: 'yes', actor: 'bot' }
                ])
              )
            }
          ]
        }
      case 'read':
        return { target, messages: messages.map(view) }
      case 'post': {
        const message = { ts: `${++clock}.000000`, author: 'Scout', text: String(call.args.text) }
        messages.push(message)
        return { target: { ref: view(message).ref, label: '#general' } }
      }
      case 'react':
        reactions.add(`${call.ref}:${String(call.args.emoji)}`)
        return { target: { ref: call.ref, label: `${String(call.args.emoji)} added` } }
      default:
        return null
    }
  }

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://fixture').pathname
      requests.push({ path, at: performance.now() })
      const body = await readJson(request)
      if (path === '/v1/desktop/auth/connector-token') {
        return send(response, 200, {
          connectorToken: 'e2e-connector-token',
          expiresAt: Math.floor(Date.now() / 1000) + 3_600
        })
      }
      if (path === '/v1/connector/hello') {
        hellos += 1
        knownBots = helloBotIds(body)
        return send(response, 200, { helloRev: hellos, features: ['actions', 'webhooks'] })
      }
      const slackApps = /^\/v1\/connector\/bots\/([^/]+)\/slack\/apps$/.exec(path)
      if (slackApps && request.method === 'POST') {
        const botId = decodeURIComponent(slackApps[1] ?? '')
        return knownBots.includes(botId)
          ? send(response, 200, {
              appId: 'A0E2E',
              authorizeUrl: 'https://slack.com/oauth/v2/authorize?client_id=e2e'
            })
          : send(response, 404, { error: 'unknown_bot' })
      }
      if (path === '/v1/connector/webhooks' && request.method === 'POST') {
        const mint = typeof body === 'object' && body !== null ? body : {}
        const botId = 'botId' in mint && typeof mint.botId === 'string' ? mint.botId : ''
        const automationId =
          'automationId' in mint && typeof mint.automationId === 'string' ? mint.automationId : ''
        return knownBots.includes(botId)
          ? send(response, 200, {
              hookId: 'wh_e2eE2Ee2eE2Ee2eE',
              automationId,
              botId,
              state: 'pending',
              epoch: 1,
              keyGeneration: 1,
              url: 'https://hooks.example.test/wh_e2eE2Ee2eE2Ee2eE',
              adapter: null,
              previousKeyExpiresAt: null,
              lastCall: null,
              pendingCalls: 0
            })
          : send(response, 404, { error: 'unknown_bot' })
      }
      if (path === '/v1/connector/poll') {
        lastPollAt = Date.now()
        response.once('close', () => {
          if (!response.writableEnded) {
            lastPollDroppedAt = performance.now()
          }
        })
        if (queued.length === 0) {
          await new Promise<void>((resolve) => {
            // ast-grep-ignore: test-no-real-time-wait -- the cloud's long-poll hold; answering at once spins the client.
            const timer = holdPolls ? undefined : setTimeout(resolve, 1_000)
            wakePoll = () => {
              clearTimeout(timer)
              resolve()
            }
          })
          wakePoll = null
        }
        const deliveries = queued.splice(0)
        return send(response, 200, { serverNow: Date.now(), holdMs: 1_000, deliveries })
      }
      if (path === '/v1/connector/acks' || path === '/v1/connector/events') {
        ;(path === '/v1/connector/acks' ? acks : events).push(body)
        return send(response, 204)
      }
      if (path === '/v1/connector/replies') {
        replies.push(body)
        return send(response, 200, { status: 'posted', messageId: `m${replies.length}` })
      }
      if (path === '/v1/connector/actions' && isActionCall(body)) {
        actions.push(body)
        const result = act(body)
        return send(
          response,
          200,
          result
            ? { ok: true, result }
            : { ok: false, refusal: 'unsupported', message: `${body.verb} isn't in this fixture.` }
        )
      }
      return send(response, 404, { error: 'not_found' })
    })().catch(() => send(response, 500, { error: 'fixture_failed' }))
  }
  const server = options.tls ? createTlsServer(options.tls, handle) : createServer(handle)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('connector actions fixture has no TCP address')
  }
  return {
    origin: `${options.tls ? 'https' : 'http'}://127.0.0.1:${address.port}`,
    actions,
    helloCount: () => hellos,
    lastPollAt: () => lastPollAt,
    lastPollDroppedAt: () => lastPollDroppedAt,
    requests,
    knownBots: () => knownBots,
    messages,
    reactions,
    holdPolls: (on) => {
      holdPolls = on
    },
    deliver: (delivery) => {
      queued.push(delivery)
      wakePoll?.()
    },
    acks,
    events,
    replies,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
  }
}
