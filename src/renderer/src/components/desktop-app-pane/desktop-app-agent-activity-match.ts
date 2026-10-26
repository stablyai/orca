import type {
  DesktopAppAgentActivity,
  DesktopAppWindow
} from '../../../../shared/desktop-app-types'
import { parseDesktopAppSelector, selectorNamesApp } from '../../../../shared/desktop-app-selector'

export type DesktopAppPaneTarget = Pick<
  DesktopAppWindow,
  'windowId' | 'pid' | 'appName' | 'bundleId'
>

/** Whether an agent's computer-use action is aimed at the app this pane shows. */
export function activityTargetsPane(
  activity: DesktopAppAgentActivity,
  target: DesktopAppPaneTarget
): boolean {
  if (activity.windowId !== null && activity.windowId !== target.windowId) {
    // Another window of the same app is not this pane's window.
    return false
  }
  if (activity.pid !== null) {
    return activity.pid === target.pid
  }
  if (activity.windowId !== null) {
    return true
  }
  return selectorTargetsApp(activity.appSelector, target)
}

function selectorTargetsApp(selector: string | null, target: DesktopAppPaneTarget): boolean {
  const parsed = parseDesktopAppSelector(selector)
  if (!parsed) {
    return false
  }
  return parsed.kind === 'pid' ? parsed.pid === target.pid : selectorNamesApp(parsed.name, target)
}
