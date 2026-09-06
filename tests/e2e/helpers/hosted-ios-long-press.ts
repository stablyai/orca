import {
  runHostedIosEmulatorCommand,
  type HostedIosEmulatorCommandOptions
} from './hosted-ios-mobile-launcher'
import { waitForHostedIosAccessibilityControl } from './hosted-ios-accessibility'
import { waitForHostedIosEvaluation } from './hosted-ios-webview-cdp'

type NormalizedPoint = {
  x: number
  y: number
}

const LONG_PRESS_MOVE_FRAMES = 60

export async function sendHostedIosLongPress(
  args: HostedIosEmulatorCommandOptions,
  point: NormalizedPoint
): Promise<void> {
  const hold = Array.from({ length: LONG_PRESS_MOVE_FRAMES }, () => ({
    type: 'move',
    ...point
  }))
  const gesture = [{ type: 'begin', ...point }, ...hold, { type: 'end', ...point }]
  await runHostedIosEmulatorCommand(args, ['gesture', JSON.stringify(gesture)])
}

export async function openHostedIosLongPressAction(
  args: HostedIosEmulatorCommandOptions & { discoveryUrl: string },
  point: NormalizedPoint,
  triggerLabel: string,
  actionLabel: string
): Promise<NormalizedPoint> {
  await sendHostedIosLongPress(args, point)
  try {
    return await waitForHostedIosAccessibilityControl(args, actionLabel, 1_000)
  } catch {
    await sendHostedIosWebViewLongPress(args.discoveryUrl, triggerLabel)
    return waitForHostedIosAccessibilityControl(args, actionLabel, 10_000)
  }
}

async function sendHostedIosWebViewLongPress(discoveryUrl: string, label: string): Promise<void> {
  const token = `hosted-long-press-${Date.now()}`
  await waitForHostedIosEvaluation(
    discoveryUrl,
    10_000,
    `(() => {
      const expected = ${JSON.stringify(label)}
      const element = Array.from(
        document.querySelectorAll('button,[role="button"],[tabindex]')
      )
        .filter(
          (candidate) =>
            candidate.getAttribute('aria-label') === expected ||
            String(candidate.textContent ?? '').trim() === expected
        )
        .sort(
          (left, right) =>
            String(left.textContent ?? '').length - String(right.textContent ?? '').length
        )[0]
      if (!(element instanceof HTMLElement)) return 'missing'
      document.getSelection()?.removeAllRanges()
      element.setAttribute('data-orca-hosted-long-press', ${JSON.stringify(token)})
      const rect = element.getBoundingClientRect()
      element.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 0,
        buttons: 1,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2
      }))
      return ${JSON.stringify(token)}
    })()`,
    (value) => value === token
  )
  await delay(600)
  await waitForHostedIosEvaluation(
    discoveryUrl,
    3_000,
    `(() => {
      const element = document.querySelector(
        '[data-orca-hosted-long-press=${JSON.stringify(token)}]'
      )
      if (!(element instanceof HTMLElement)) return ${JSON.stringify(token)}
      const rect = element.getBoundingClientRect()
      element.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 0,
        buttons: 0,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2
      }))
      element.removeAttribute('data-orca-hosted-long-press')
      return ${JSON.stringify(token)}
    })()`,
    (value) => value === token
  )
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
