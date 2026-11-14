export type ComputerUseErrorRecoveryData = {
  nextSteps: string[]
}

// Why: agents follow recovery text, so a foreground retry must stay the user's decision.
const FOREGROUND_ONLY_WITH_CONSENT =
  'If only foreground input can do it, stop and tell the user what needs the foreground. Ask the user before retrying with `--restore-window`: it brings the app forward and takes over their screen, keyboard and pointer. Never add it on your own.'

export function computerUseErrorRecoveryData(
  code: string,
  message?: string
): ComputerUseErrorRecoveryData | undefined {
  switch (code) {
    case 'app_not_found':
      return recoverWith(
        'Run `orca computer list-apps --json` and retry with the exact app name or bundle ID.',
        'If the app is not running, start it with `orca computer launch-app <app>` (macOS and Windows), which tries to leave the user in the app they are using (check its `delivery`); on Linux ask the user to.',
        'If the target is a website or web app such as Gmail, choose the desktop browser app/window that contains it; `orca computer` app selectors refer to desktop apps, not website names.',
        'Do not retry the same `orca computer ... --app <web app>` command unchanged.',
        'If the desired browser is not listed, start it with `orca computer launch-app <browser>` so it opens in the background (macOS and Windows); on Linux ask the user to start it. Then retry `orca computer list-apps --json` and `orca computer list-windows --app <browser> --json`.'
      )
    case 'app_blocked':
      return recoverWith(
        'Do not continue with this app through computer-use; choose a non-sensitive target or ask the user to handle it manually.'
      )
    case 'system_shortcut_blocked':
      return recoverWith(
        'Do not retry this shortcut; the error says what it would do. Reach the same goal with a semantic action such as a button or menu item, or ask the user to do it.',
        'Retry with `--allow-system-shortcut` only when the user explicitly asked for this exact shortcut.'
      )
    case 'window_not_found':
      return recoverWith(
        'Run `orca computer list-windows --app <app> --json` and target one of the listed windows.',
        'If the app is listed but has no usable window, ask the user to open or show one. Do not add `--restore-window` on your own, not even just to observe.',
        'If no window is listed, the app may have none open; ask the user to open one.'
      )
    case 'window_not_focused':
      if (message?.includes('may already have been delivered')) {
        return recoverWith(
          'Run `orca computer get-app-state --app <app> --json` and verify whether the intended action already occurred before retrying.',
          'Do not retry if it already took effect; otherwise retry from fresh state.'
        )
      }
      if (
        message?.includes('was requested') ||
        message?.includes('did not focus the target window')
      ) {
        return recoverWith(
          'The window could not be brought forward, so do not retry with `--restore-window`. Ask the user to bring the window forward or check permissions, or use `set-value` for editable fields.'
        )
      }
      return recoverWith(
        'Nothing was sent. For editable fields use `set-value`, or `type-text --element-index` where `orca computer capabilities --json` lists `actions.typeTextElement`.',
        FOREGROUND_ONLY_WITH_CONSENT
      )
    case 'background_unavailable':
      return recoverWith(
        'If the message names a popup menu or `<select>`, set its option with `orca computer set-value` on that element instead of clicking.',
        'Otherwise reach the goal with a semantic action such as `set-value` or `perform-secondary-action` if one fits.',
        FOREGROUND_ONLY_WITH_CONSENT
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
      if (message?.includes('target_elevated')) {
        return recoverWith(
          'Do not retry: Windows blocks input from a non-administrator Orca to an app running as administrator.',
          'Ask the user to handle this window, or to restart Orca as administrator if they want it to control elevated apps.'
        )
      }
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
      if (message?.includes(' is covered by ')) {
        return recoverWith(
          'Run `orca computer get-app-state --app <app> --json` and deal with what covers the element first (answer or close the dialog, sheet or popover).',
          'Then click the element again using an index from the fresh tree; do not click by coordinates to get past the cover.'
        )
      }
      if (message?.includes(' out of view')) {
        return recoverWith(
          "Scroll the element's container with `orca computer scroll`, then run `orca computer get-app-state --app <app> --json` and click the element using an index from the fresh tree."
        )
      }
      return recoverWith(
        'Choose a nearby parent or child element that has an actionable frame.',
        'If using coordinates, derive window-local coordinates from the latest screenshot/state for the same target window.'
      )
    case 'element_not_enabled':
      return recoverWith(
        'The element is disabled, so nothing was sent. Do what enables it first (for example fill required fields), then run `orca computer get-app-state --app <app> --json` and act once its line no longer lists `disabled`.',
        'Do not retry the same action unchanged or click it by coordinates instead.'
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
      if (message?.includes('window_not_responding')) {
        return recoverWith(
          message.includes('may already have been delivered')
            ? 'Wait a few seconds, then run `orca computer get-app-state --app <app> --json` and check whether the action already took effect before retrying it.'
            : 'Wait a few seconds for the app to respond, then run `orca computer get-app-state --app <app> --json` again.',
          'If it stays unresponsive, ask the user to close or restart the app; do not keep sending it input.'
        )
      }
      return recoverWith(
        'Run `orca computer get-app-state --app <app> --json` before retrying so you know whether the UI changed.',
        'Retry with a simpler semantic action or `--no-screenshot` if observation is slow; do not repeat the same timed-out action blindly.'
      )
    case 'verification_failed':
      return recoverWith(
        'Run `orca computer get-app-state --app <app> --json` and check which field holds the value; another field may have changed instead.',
        'Do not retry the same `set-value` unchanged. For editable text, click the field and confirm focus, select all (`cmd+a` on macOS, `ctrl+a` on Windows/Linux), then use `type-text` and inspect the resulting value.'
      )
    case 'screenshot_failed':
      return recoverWith(
        'If the accessibility tree is sufficient, rerun the command with `--no-screenshot` instead of retrying the same screenshot capture.',
        'If the message mentions Screen Recording or screenshots permission, run `orca computer permissions --id screenshots --json` and grant access before retrying.',
        'If the message mentions the payload cap, target a smaller/current window or use `--no-screenshot`.'
      )
    case 'accessibility_error':
      // Why: an Orca server installed before it bundled computer use reports only this exit (#31777).
      if (message?.startsWith('computer sidecar exited with code')) {
        return recoverWith(
          'If this targets an Orca server (`orca serve`, SSH or WSL), its install may not include computer use: update or reprovision the server, then retry.',
          'Run `orca computer capabilities --json` to confirm the provider is available before retrying.'
        )
      }
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
