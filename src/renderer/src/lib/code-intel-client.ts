import type { CodeIntelMethod, CodeIntelResult } from '../../../shared/code-intel-contract'

export type CodeIntelClientArgs = {
  filePath: string
  relativePath: string
  position: { line: number; character: number }
  bufferVersion: number
  bufferText?: string
  connectionId?: string
}

// Structurally compatible with Monaco's CancellationToken, but defined locally so
// this client stays free of a monaco import and easy to unit-test.
export type CodeIntelCancellation = {
  readonly isCancellationRequested: boolean
  onCancellationRequested: (listener: () => void) => { dispose: () => void }
}

let nextRequestId = 1

export async function queryCodeIntel(
  method: CodeIntelMethod,
  args: CodeIntelClientArgs,
  token?: CodeIntelCancellation
): Promise<CodeIntelResult> {
  if (token?.isCancellationRequested) {
    return { status: 'error', code: 'cancelled', message: 'request cancelled' }
  }
  const bridge = window.api.codeIntel
  const requestId = nextRequestId++
  // Why: forward the cancellation downstream — the main process aborts the
  // in-flight sidecar query keyed by this request id.
  const subscription = token?.onCancellationRequested(() => bridge.cancel(requestId))
  try {
    const payload = { ...args, requestId }
    return method === 'definition'
      ? await bridge.definition(payload)
      : await bridge.references(payload)
  } catch (error) {
    return {
      status: 'error',
      code: 'bridge-failure',
      message: error instanceof Error ? error.message : String(error)
    }
  } finally {
    subscription?.dispose()
  }
}
