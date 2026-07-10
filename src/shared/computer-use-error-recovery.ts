export type ComputerUseErrorRecoveryData = {
  nextSteps: string[]
}

export function computerUseErrorRecoveryData(
  code: string
): ComputerUseErrorRecoveryData | undefined {
  switch (code) {
    case 'app_not_found':
      return recoverWith(
        'Run `orca computer list-apps --json` and retry with the exact app name or bundle ID.',
        'If the target is a website or web app such as Gmail, choose the desktop browser app/window that contains it; `orca computer` app selectors refer to desktop apps, not website names.',
        'Do not retry the same `orca computer ... --app <web app>` command unchanged.',
        'If the desired browser is not listed, open or focus that browser first, then retry `orca computer list-apps --json` and `orca computer list-windows --app <browser> --json`.'
      )
    case 'app_blocked':
      return recoverWith(
        'Do not continue with this app through computer-use; choose a non-sensitive target or ask the user to handle it manually.'
      )
    case 'window_not_found':
      return recoverWith(
        'Run `orca computer list-windows --app <app> --json` and target one of the listed windows.',
        'If the app is listed but no usable window is visible, retry observation once with `--restore-window`.',
        'If no window is listed, open or focus the app first; `orca computer` does not launch closed desktop apps.'
      )
    case 'window_not_focused':
      return recoverWith(
        'Retry once with `--restore-window`.',
        'If `--restore-window` was already used, stop retrying restore; bring the app forward manually, check permissions, or prefer `set-value` for editable fields.'
      )
    case 'window_stale':
      return recoverWith(
        'Run `orca computer list-windows --app <app> --json` and choose a current window selector.',
        'Then rerun `orca computer get-app-state --app <app> --json` before acting.'
      )
    case 'provider_incompatible':
      return recoverWith(
        'Run `orca computer capabilities --json` and verify the local provider supports the requested operation.',
        'Update Orca or use a supported platform/provider path before retrying.'
      )
    case 'unsupported_capability':
      return recoverWith(
        'Run `orca computer capabilities --json` and choose a supported action.',
        'Use a semantic alternative such as `set-value` or `click`, or install the missing desktop dependency if the error names one.'
      )
    case 'permission_denied':
      return recoverWith(
        'Run `orca computer permissions --json`, or `orca computer permissions --id accessibility --json` / `--id screenshots --json` when the message names one missing permission.',
        'For remote or SSH targets, verify the command is running inside an active graphical desktop session.'
      )
    case 'element_not_found':
      return recoverWith(
        'Run `orca computer get-app-state --app <app> --json` again and use an element index from the fresh tree.',
        'Do not infer valid indexes from `elementCount` or reuse indexes after navigation, scrolling, focus changes, or delays.'
      )
    case 'element_not_clickable':
      return recoverWith(
        'Choose a nearby parent or child element that has an actionable frame.',
        'If using coordinates, derive window-local coordinates from the latest screenshot/state for the same target window.'
      )
    case 'action_not_supported':
      return recoverWith(
        'Inspect the element in a fresh `get-app-state` result and use one of its advertised secondary actions.',
        'If no suitable action is listed, use `click`, `set-value`, or another semantic action instead.'
      )
    case 'value_not_settable':
      return recoverWith(
        'Choose a settable text element from a fresh `get-app-state` result.',
        'If the target cannot accept direct value writes, focus it and use keyboard input only after inspecting the returned state.'
      )
    case 'invalid_argument':
      return recoverWith(
        'Fix the command flags or RPC params exactly as described by the error message.',
        'Do not retry the same command unchanged.'
      )
    case 'action_timeout':
      return recoverWith(
        'Run `orca computer get-app-state --app <app> --json` before retrying so you know whether the UI changed.',
        'Retry with a simpler semantic action or `--no-screenshot` if observation is slow; do not repeat the same timed-out action blindly.'
      )
    case 'screenshot_failed':
      return recoverWith(
        'If the accessibility tree is sufficient, rerun the command with `--no-screenshot` instead of retrying the same screenshot capture.',
        'If the message mentions Screen Recording or screenshots permission, run `orca computer permissions --id screenshots --json` and grant access before retrying.',
        'If the message mentions the payload cap, target a smaller/current window or use `--no-screenshot`.'
      )
    case 'accessibility_error':
      return recoverWith(
        'Run `orca computer capabilities --json` to confirm the provider is available before retrying.',
        'If the message mentions permissions, run `orca computer permissions --id accessibility --json` and grant access.',
        'Do not loop on the same action if provider availability or permissions remain unchanged.'
      )
    default:
      return undefined
  }
}

function recoverWith(...nextSteps: string[]): ComputerUseErrorRecoveryData {
  return { nextSteps }
}
