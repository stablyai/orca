import { useEffect, useState } from 'react'
import { DropdownMenuLabel } from '../../../ui/dropdown-menu'
import { useAppStore } from '../../../../store/index'
import { useTranslate } from '@/i18n/use-translate'
import { isRemoteCliControlAllowed } from '../../../../../../shared/remote-runtime/ssh/ssh-remote-cli-control'
import type {
  BrowserPageCookieImportRoute,
  BrowserSshPageCookieImportRoute
} from '@/store/slices/browser/browser-slice-contract'

// Name the import machine for remote pages: it chooses the browser inventory and receives permission prompts. Local imports need no notice.
export function BrowserCookieImportMachineNotice({
  pageRoute = null,
  settingsSshRoute = null
}: {
  /** Set when a page imports into its own jar; Settings imports follow the Settings host. */
  pageRoute?: BrowserPageCookieImportRoute | null
  /** Settings' selected host when it is an SSH host. */
  settingsSshRoute?: BrowserSshPageCookieImportRoute | null
}): React.JSX.Element | null {
  const t = useTranslate()
  const settingsBrowsersHost = useAppStore((s) => s.detectedBrowsersHost)
  if (pageRoute?.kind === 'ssh') {
    return <SshPageCookieImportNotice route={pageRoute} />
  }
  // Settings on an SSH host fills that host's jar, the same one its pages' import fills.
  if (!pageRoute && settingsSshRoute) {
    return <SshPageCookieImportNotice route={settingsSshRoute} />
  }
  // A server's This-device jar: its agents always drive these pages but never get the cookies.
  if (pageRoute?.kind === 'client-host') {
    return <RoutedPageCookieImportNotice hostLabel={pageRoute.hostLabel} hostAgentsCanBrowse />
  }
  if (pageRoute || !settingsBrowsersHost) {
    return null
  }
  if (settingsBrowsersHost.machine === 'client') {
    return (
      <RoutedPageCookieImportNotice
        hostLabel={settingsBrowsersHost.hostLabel}
        hostAgentsCanBrowse
      />
    )
  }
  return (
    <>
      <DropdownMenuLabel>
        {t(
          'auto.components.BrowserCookieImportMachineNotice.remoteLabel',
          'Browsers on {{value0}}',
          { value0: settingsBrowsersHost.hostLabel }
        )}
      </DropdownMenuLabel>
      <p className="max-w-60 px-2 pb-1.5 text-[11px] leading-4 text-muted-foreground">
        {t(
          'auto.components.BrowserCookieImportMachineNotice.remoteNoteRemoteStorage',
          'Imports read browsers on {{value0}}. Cookies are stored on that machine, and a permission prompt may appear on its screen.',
          { value0: settingsBrowsersHost.hostLabel }
        )}
      </p>
    </>
  )
}

function SshPageCookieImportNotice({
  route
}: {
  route: BrowserSshPageCookieImportRoute
}): React.JSX.Element {
  const hostAgentsCanBrowse = useSshHostAgentsCanBrowse(route.sshTargetId)
  return (
    <RoutedPageCookieImportNotice
      hostLabel={route.hostLabel}
      hostAgentsCanBrowse={hostAgentsCanBrowse}
    />
  )
}

/** A jar on this desktop that pages of another host use; that host's agents get the sign-ins, not the cookies. */
function RoutedPageCookieImportNotice({
  hostLabel,
  hostAgentsCanBrowse
}: {
  hostLabel: string
  hostAgentsCanBrowse: boolean
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      <DropdownMenuLabel>
        {t('browser.cookieImport.routedPage.label', 'Browsers on this device')}
      </DropdownMenuLabel>
      <p className="max-w-60 px-2 pb-1.5 text-[11px] leading-4 text-muted-foreground">
        {t(
          'browser.cookieImport.routedPage.destination',
          'Imports into the browser for {{host}}.',
          { host: hostLabel }
        )}
        {hostAgentsCanBrowse
          ? ` ${t(
              'browser.cookieImport.routedPage.hostAgents',
              'Agents on {{host}} can use these sign-ins, but can’t read the cookies.',
              { host: hostLabel }
            )}`
          : null}
      </p>
    </>
  )
}

/** The per-host "control Orca browser tabs" switch decides whether that host's agents drive these pages. */
function useSshHostAgentsCanBrowse(sshTargetId: string): boolean {
  const [allowed, setAllowed] = useState(false)
  useEffect(() => {
    let cancelled = false
    void window.api.ssh
      .listTargets()
      .then((targets) => {
        if (!cancelled) {
          setAllowed(isRemoteCliControlAllowed(targets.find((t) => t.id === sshTargetId)))
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [sshTargetId])
  return allowed
}
