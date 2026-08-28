import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { TuiAgent } from '../../../shared/tui-agent'
import { normalizeProxyUrl } from '../../../shared/network-proxy'

type ProxySettings = { httpProxyUrl?: string }

/** Explain the app-level proxy context before a Claude process makes its first request. */
export function warnIfConfiguredClaudeProxy(
  agent: TuiAgent,
  settings: ProxySettings | null | undefined
): void {
  const proxy = normalizeProxyUrl(settings?.httpProxyUrl)
  if (agent !== 'claude' || !proxy.ok || !proxy.value) {
    return
  }
  toast.warning(
    translate(
      'auto.lib.claude.launch.proxy.notice.9f4a8d7c21',
      'Orca network proxy is configured for this Claude launch; the target host is routed through it unless covered by its bypass rules. If Claude reports ConnectionRefused, check Settings → Advanced → Network.'
    ),
    { duration: 12_000 }
  )
}
