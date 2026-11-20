// QA-only render counter for the bot Home panel benchmark; does nothing unless a probe installs `__bhp`.
export function probeRender(name: string): void {
  const counts = (globalThis as { __bhp?: Record<string, number> }).__bhp
  if (counts) {
    counts[name] = (counts[name] ?? 0) + 1
  }
}
