import { vi } from 'vitest'

export function resumeSonnerMock(): { toast: ReturnType<typeof vi.fn> } {
  const toast = vi.fn()
  const kind = (): ReturnType<typeof vi.fn> => vi.fn((...args: unknown[]) => toast(...args))
  return { toast: Object.assign(toast, { success: kind(), warning: kind(), error: kind() }) }
}
