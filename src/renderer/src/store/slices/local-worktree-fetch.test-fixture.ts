import { vi } from 'vitest'
import type { AppState } from '@/store/types'

export function localWorktreeFetch(result: Promise<boolean>): AppState['fetchWorktrees'] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these fixtures exercise only the local fetch overload; no direct-SSH request reaches this Boolean stub.
  return vi.fn(() => result) as AppState['fetchWorktrees']
}
