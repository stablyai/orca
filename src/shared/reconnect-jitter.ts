// Why: a blip on a shared path (Tailscale, cellular, host restart) drops every socket on that path in
// the same instant. A jitterless backoff ladder then re-dials all of them at the same millisecond,
// which is exactly the thundering herd the host is least able to absorb while it is still recovering.
// One-sided so a delay is never shortened below its backoff floor.
export function withReconnectJitter(delayMs: number, random: () => number = Math.random): number {
  return delayMs + Math.floor(delayMs * 0.2 * random())
}
