import type { PreparedJcodeHook } from './jcode-hook-preparation'
import { takeResolvedJcodeEvents, type JcodeSessionInput } from './jcode-session-registry'
import type { HookListenerState } from './listener-state'

export function ingestPreparedJcodeHooks(
  state: HookListenerState,
  input: JcodeSessionInput,
  prepare: (input: JcodeSessionInput) => PreparedJcodeHook | null,
  accept: (prepared: PreparedJcodeHook, input: JcodeSessionInput) => void
): void {
  const body = input.body
  if (
    !body ||
    typeof body !== 'object' ||
    !('paneKey' in body) ||
    typeof body.paneKey !== 'string'
  ) {
    return
  }
  const paneKey = body.paneKey.trim()
  const attempted = new Set<JcodeSessionInput>()
  const apply = (next: JcodeSessionInput) => {
    attempted.add(next)
    const prepared = prepare(next)
    if (prepared) {
      accept(prepared, next)
    }
  }
  const drain = () => {
    for (;;) {
      const next = takeResolvedJcodeEvents(state, paneKey).find((entry) => !attempted.has(entry))
      if (!next) {
        return
      }
      // Each accepted root changes how the next queued input resolves.
      apply(next)
    }
  }
  drain()
  apply(input)
  drain()
}
