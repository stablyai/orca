import { vi } from 'vitest'

/** The `sonner` module for resume tests: every toast lands on `toast`'s calls, and each kind keeps its own. */
export function resumeSonnerMock(): { toast: ReturnType<typeof vi.fn> } {
  const toast = vi.fn()
  const kind = (): ReturnType<typeof vi.fn> => vi.fn((...args: unknown[]) => toast(...args))
  return { toast: Object.assign(toast, { success: kind(), warning: kind(), error: kind() }) }
}
