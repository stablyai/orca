// Shared network blips drop sockets together; jitter avoids synchronized redial while hosts recover.
// Only extend delays so backoff floors remain intact.
export function withReconnectJitter(delayMs: number, random: () => number = Math.random): number {
  return delayMs + Math.floor(delayMs * 0.2 * random())
}
