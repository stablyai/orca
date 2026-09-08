import { writeHostedIosSimulatorPasteboard } from '../../../mobile/scripts/hosted-ios-terminal-clipboard-paste.mjs'
import {
  HOSTED_IOS_TERMINAL_CLIPBOARD_PASTE_CAPTURE,
  hostedIosTerminalInputCaptureExpression
} from './hosted-ios-terminal-cdp-expressions'
import {
  runHostedIosEmulatorCommand,
  type HostedIosEmulatorCommandOptions
} from './hosted-ios-emulator-command'
import { waitForHostedIosAccessibilityControl } from './hosted-ios-accessibility'
import { waitForHostedIosEvaluation } from './hosted-ios-webview-cdp'

type PastedTerminalCommandOperations = {
  tapControl?: typeof tapHostedIosAccessibilityControl
  waitForEvaluation?: typeof waitForHostedIosEvaluation
  writePasteboard?: typeof writeHostedIosSimulatorPasteboard
}

export async function sendHostedIosPastedTerminalCommand(
  args: HostedIosEmulatorCommandOptions & { discoveryUrl: string },
  command: string,
  operations: PastedTerminalCommandOperations = {}
): Promise<{ expected: string; requireCarriageReturn: true }> {
  const tapControl = operations.tapControl ?? tapHostedIosAccessibilityControl
  const waitForEvaluation = operations.waitForEvaluation ?? waitForHostedIosEvaluation
  const writePasteboard = operations.writePasteboard ?? writeHostedIosSimulatorPasteboard
  await writePasteboard(args.deviceUdid, command)
  let lastActivationError: unknown
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await tapControl(args, 'Paste', 20_000)
    await allowHostedIosPasteIfRequested(args, tapControl)
    try {
      await waitForEvaluation(
        args.discoveryUrl,
        5_000,
        hostedIosTerminalInputCaptureExpression,
        (value) => value.includes(HOSTED_IOS_TERMINAL_CLIPBOARD_PASTE_CAPTURE)
      )
      lastActivationError = undefined
      break
    } catch (error) {
      lastActivationError = error
    }
  }
  if (lastActivationError) {
    throw lastActivationError
  }
  await waitForEvaluation(
    args.discoveryUrl,
    10_000,
    `(() => {
      const label = Array.from(document.querySelectorAll('body *')).find(
        (candidate) =>
          candidate.children.length === 0 &&
          String(candidate.textContent ?? '').trim() === 'Enter'
      )
      const control = label?.closest('button,[role="button"],[tabindex]')
      if (!(control instanceof HTMLElement)) return 'missing'
      control.click()
      return 'clicked'
    })()`,
    (value) => value === 'clicked'
  )
  return {
    expected: HOSTED_IOS_TERMINAL_CLIPBOARD_PASTE_CAPTURE,
    requireCarriageReturn: true
  }
}

async function tapHostedIosAccessibilityControl(
  args: HostedIosEmulatorCommandOptions,
  label: string,
  timeoutMs: number
): Promise<void> {
  const control = await waitForHostedIosAccessibilityControl(args, label, timeoutMs)
  await runHostedIosEmulatorCommand(args, ['tap', String(control.x), String(control.y)])
}

async function allowHostedIosPasteIfRequested(
  args: HostedIosEmulatorCommandOptions,
  tapControl: typeof tapHostedIosAccessibilityControl
): Promise<void> {
  try {
    await tapControl(args, 'Allow Paste', 3_000)
  } catch {
    // The prompt appears only after the first cross-app paste.
  }
}
