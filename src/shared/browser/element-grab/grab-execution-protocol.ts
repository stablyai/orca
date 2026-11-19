export const GRAB_EXECUTION_REQUEST = 'browser:grab-execution-request'
export const GRAB_EXECUTION_REPORT = 'browser:grab-execution-report'
export type GrabExecutionResult = { ok: true; value: unknown } | { ok: false }
export type GrabPickOperation = 'present' | 'snapshot' | 'prepareCapture'
export type GrabExecutionRequest =
  | { kind: 'hello'; id: string }
  | { kind: 'retire'; documentId: string; overlayId: string }
  | { kind: 'restoreCapture'; documentId: string; captureId: string }
  | {
      kind: 'execute'
      id: string
      documentId: string
      code: string
      worldId: number
      lane: 'script' | 'selection'
      expiresAt: number
      clean?: boolean
      overlayControl?: boolean
      capturePick?: 'held' | 'hover'
      pick?: { selectionId: string; operation: GrabPickOperation; captureId?: string }
    }
