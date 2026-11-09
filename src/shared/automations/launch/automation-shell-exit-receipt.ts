import { createOsc133CommandFinishedScanner } from '../../terminal/output/terminal-osc133-command-finished'

export function createAutomationShellReceiptScanner(
  runId: string,
  onExitCode: (code: number) => void
) {
  return createOsc133CommandFinishedScanner((code, marker, rawCode) => {
    if (
      marker === `orca-automation:${runId}` &&
      rawCode !== undefined &&
      /^-?\d+$/.test(rawCode) &&
      code !== null &&
      Number.isSafeInteger(code)
    ) {
      onExitCode(code)
    }
  })
}
