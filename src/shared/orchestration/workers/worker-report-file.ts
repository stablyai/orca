// Leave room for the report body and protocol framing inside a paired runtime request.
export const MAX_WORKER_REPORT_BYTES = 512 * 1024

export type WorkerReportFile = {
  messageId: string
  dispatchId: string
  reportPath: string
  sha256: string
  contentBase64: string
}
