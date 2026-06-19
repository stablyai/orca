import { toast } from 'sonner'
import type { GlobalSettings } from '../../../../shared/types'
import {
  getTerminalHttpBrowserTipCopy,
  type TerminalHttpRouteContext
} from './terminal-http-link-routing'
import { translate } from '@/i18n/i18n'

let hasShownTerminalBrowserTipToast = false

type ShowTerminalBrowserTipToastInput = {
  context: TerminalHttpRouteContext
  settings: GlobalSettings | null | undefined
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<unknown>
  setSettingsSearchQuery: (query: string) => void
  openSettingsTarget: (target: { pane: 'browser'; repoId: null }) => void
  openSettingsPage: () => void
}

export function showTerminalBrowserTipToast(input: ShowTerminalBrowserTipToastInput): boolean {
  const { settings } = input
  if (!settings || settings.openLinksInAppPreferencePrompted === true) {
    return false
  }
  if (hasShownTerminalBrowserTipToast) {
    return false
  }
  hasShownTerminalBrowserTipToast = true
  const copy = getTerminalHttpBrowserTipCopy({
    ...input.context,
    openLinksInApp: settings.openLinksInApp === true,
    activeRuntimeEnvironmentId: settings.activeRuntimeEnvironmentId ?? null
  })
  toast.info(copy.title, {
    description: copy.description,
    duration: 12_000,
    action: {
      label: translate(
        'auto.components.terminalPane.terminalBrowserTipToast.openSettings',
        'Open Settings'
      ),
      onClick: () => {
        input.setSettingsSearchQuery('')
        input.openSettingsTarget({ pane: 'browser', repoId: null })
        input.openSettingsPage()
      }
    }
  })
  void input.updateSettings({ openLinksInAppPreferencePrompted: true }).catch(() => {
    /* Session suppression above prevents repeated first-use nags. */
  })
  return true
}

export function resetTerminalBrowserTipToastForTests(): void {
  hasShownTerminalBrowserTipToast = false
}
