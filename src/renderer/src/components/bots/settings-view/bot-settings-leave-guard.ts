// A subpage that must ask before the view leaves it (Back, Escape), such as Soul with a disk conflict open.
import { createContext, useContext, useEffect, useRef } from 'react'

/** Resolves true when the view may leave. */
export type BotSettingsLeaveGuard = () => Promise<boolean>

/** The view's one guard slot: the open subpage registers into it; Back and Escape ask it. */
export type BotSettingsLeaveGuards = {
  register: (guard: BotSettingsLeaveGuard) => () => void
  ask: () => Promise<boolean>
}

export function createBotSettingsLeaveGuards(): BotSettingsLeaveGuards {
  let current: BotSettingsLeaveGuard | null = null
  return {
    register: (guard) => {
      current = guard
      return () => {
        if (current === guard) {
          current = null
        }
      }
    },
    ask: () => (current ? current() : Promise.resolve(true))
  }
}

export const BotSettingsLeaveGuardContext = createContext<BotSettingsLeaveGuards | null>(null)

/** Asks `guard` before the view leaves this subpage; null asks nothing. Outside the view, a no-op. */
export function useBotSettingsLeaveGuard(guard: BotSettingsLeaveGuard | null): void {
  const guards = useContext(BotSettingsLeaveGuardContext)
  const latest = useRef(guard)
  useEffect(() => {
    latest.current = guard
  })
  const active = guard !== null
  useEffect(
    () =>
      guards && active
        ? guards.register(() => latest.current?.() ?? Promise.resolve(true))
        : undefined,
    [guards, active]
  )
}
