import type { AgentSessionCommandsResult } from './agent-session-wire'

/** Own recovery only while this target's menu is demanded. */
export function startAgentSessionCommandMenuQuery(
  read: () => Promise<AgentSessionCommandsResult>,
  accept: (result: AgentSessionCommandsResult) => void
): { invalidate(): void; dispose(): void } {
  let stopped = false
  let running = false
  let dirty = false
  let failures = 0
  let deadline = Date.now() + 330_000
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = (delay: number): void => {
    clearTimeout(timer)
    if (!stopped && Date.now() + delay < deadline) {
      timer = setTimeout(() => void run(), delay)
    }
  }
  const run = async (): Promise<void> => {
    if (stopped || Date.now() >= deadline) {
      return
    }
    running = true
    dirty = false
    let delay: number | undefined
    try {
      const result = await read()
      if (stopped || Date.now() >= deadline) {
        return
      }
      accept(result)
      failures = 0
      if (result.commandsPending) {
        delay = 10_000
      }
    } catch {
      if (++failures < 3) {
        delay = 10_000
      }
    } finally {
      running = false
      if (dirty) {
        schedule(0)
      } else if (delay !== undefined) {
        schedule(delay)
      }
    }
  }
  void run()
  return {
    invalidate() {
      if (stopped) {
        return
      }
      failures = 0
      deadline = Date.now() + 330_000
      dirty = true
      if (!running) {
        schedule(0)
      }
    },
    dispose() {
      stopped = true
      dirty = false
      clearTimeout(timer)
    }
  }
}
