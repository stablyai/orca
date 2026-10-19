import {
  applyBrowserAutomationActivity,
  clearBrowserAutomationActivity
} from '@/lib/browser-automation-activity'

export function registerBrowserAutomationActivityIpcBridge(unsubs: (() => void)[]): void {
  const unsubscribe = window.api.browser.onAutomationActivity?.(applyBrowserAutomationActivity)
  if (unsubscribe) {
    unsubs.push(() => {
      unsubscribe()
      clearBrowserAutomationActivity()
    })
  }
}
