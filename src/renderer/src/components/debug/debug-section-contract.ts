import type { DebugClient } from '@/lib/debug/debug-client'
import type { DebugSessionState } from '@/lib/debug/use-debug-session'
import type { DebugWorktree } from '../../../../preload/api/debug-api'

export type DebugSectionsClient = Pick<
  DebugClient,
  | 'scopes'
  | 'variables'
  | 'evaluate'
  | 'setVariable'
  | 'setExceptionFilters'
  | 'updateBreakpoint'
  | 'removeBreakpoint'
  | 'listBreakpoints'
>

export type DebugRevealSource = (filePath: string, line: number, column?: number) => void

export type DebugSectionProps = {
  client: DebugSectionsClient
  target: DebugWorktree
  session: DebugSessionState
}

export function debugErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function relativeToRoot(root: string, filePath: string): string {
  const separator = filePath.charAt(root.length)
  return filePath.startsWith(root) && (separator === '/' || separator === '\\')
    ? filePath.slice(root.length + 1)
    : filePath
}
