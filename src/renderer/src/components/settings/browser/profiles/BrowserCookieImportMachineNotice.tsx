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
  pageRoute = null
}: {
  /** Set when a page imports into its own jar; Settings imports follow the Settings host. */
  pageRoute?: BrowserPageCookieImportRoute | null
}): React.JSX.Element | null {
  const t = useTranslate()
  const settingsBrowsersHost = useAppStore((s) => s.detectedBrowsersHost)
  if (pageRoute?.kind === 'ssh') {
    return <SshPageCookieImportNotice route={pageRoute} />
  }
  // A page always imports this desktop's browsers; only a server's page needs saying so.
  const detectedBrowsersHost = !pageRoute
    ? settingsBrowsersHost
    : pageRoute.kind === 'client-host'
      ? { machine: 'client' as const, hostLabel: pageRoute.hostLabel }
      : null
  if (!detectedBrowsersHost) {
    return null
  }
  const clientHosted = detectedBrowsersHost.machine === 'client'
  const hostLabel = detectedBrowsersHost.hostLabel
  return (
    <>
      <DropdownMenuLabel>
        {clientHosted
          ? t(
              'auto.components.BrowserCookieImportMachineNotice.clientLabel',
              'Browsers on this device'
            )
          : t(
              'auto.components.BrowserCookieImportMachineNotice.remoteLabel',
              'Browsers on {{value0}}',
              { value0: hostLabel }
            )}
      </DropdownMenuLabel>
      <p className="max-w-60 px-2 pb-1.5 text-[11px] leading-4 text-muted-foreground">
        {clientHosted
          ? t(
              'auto.components.BrowserCookieImportMachineNotice.clientNoteLocalStorage',
              'Imports read this device’s browsers. Cookies are stored locally.'
            )
          : t(
              'auto.components.BrowserCookieImportMachineNotice.remoteNoteRemoteStorage',
              'Imports read browsers on {{value0}}. Cookies are stored on that machine, and a permission prompt may appear on its screen.',
              { value0: hostLabel }
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
  const t = useTranslate()
  const hostAgentsCanBrowse = useSshHostAgentsCanBrowse(route.sshTargetId)
  return (
    <>
      <DropdownMenuLabel>
        {t('browser.cookieImport.sshPage.label', 'Browsers on this device')}
      </DropdownMenuLabel>
      <p className="max-w-60 px-2 pb-1.5 text-[11px] leading-4 text-muted-foreground">
        {t('browser.cookieImport.sshPage.destination', 'Imports into the browser for {{host}}.', {
          host: route.hostLabel
        })}
        {hostAgentsCanBrowse
          ? ` ${t(
              'browser.cookieImport.sshPage.hostAgents',
              'Agents on {{host}} can use these sign-ins, but can’t read the cookies.',
              { host: route.hostLabel }
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
