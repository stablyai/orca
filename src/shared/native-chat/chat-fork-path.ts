/** How a fork opens: as a chat (a structured session) or in a terminal running the agent's CLI. */
export type ChatForkSurface = 'chat' | 'terminal'

/** How a fork travels. `same`: the exact history, cut on the chat's own host and opened as the
 *  chat's own kind. `relay`: the exact history exported by the chat's host and imported by the
 *  target (any host, either kind). `recap`: the history up to the fork point as the new session's
 *  first message, for any agent on any host. */
export type ChatForkPath = 'same' | 'relay' | 'recap'

export function chatForkPath(input: {
  sameAgent: boolean
  sameHost: boolean
  sameSurface: boolean
  /** The chat's host can cut an exact copy for the chat's own kind. */
  cutsHere: boolean
  /** The chat's host exports its exact history and the target host imports it. */
  relays: boolean
}): ChatForkPath {
  if (!input.sameAgent) {
    return 'recap'
  }
  if (input.sameHost && input.sameSurface && input.cutsHere) {
    return 'same'
  }
  return input.relays ? 'relay' : 'recap'
}

/** Which kinds a fork can open as, and the one it starts on: the chat's own kind when it can. */
export function chatForkSurfaceChoice(input: {
  sourceSurface: ChatForkSurface
  picked: ChatForkSurface | undefined
  available: Readonly<Record<ChatForkSurface, boolean>>
}): ChatForkSurface | null {
  const other: ChatForkSurface = input.sourceSurface === 'chat' ? 'terminal' : 'chat'
  for (const surface of [input.picked, input.sourceSurface, other]) {
    if (surface && input.available[surface]) {
      return surface
    }
  }
  return null
}
