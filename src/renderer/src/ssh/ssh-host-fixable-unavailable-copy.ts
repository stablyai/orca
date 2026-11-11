// Mirror main's host-fixable OrcadHostUnavailableReason values; each names what to change on the host.
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function hostFixableUnavailableText(
  reason: string,
  t: Translate = translate
): string | null {
  switch (reason) {
    case 'runtime_noexec':
      return t(
        'auto.components.settings.sshHostServer.runtimeNoexec',
        'This host doesn’t allow running programs from ~/.orca-remote, so Orca can’t start its server there. This usually means the home folder is mounted with noexec. Ask the host’s administrator to allow running programs there, then connect again.'
      )
    case 'windows_build_unsupported':
      return t(
        'auto.components.settings.sshHostServer.windowsBuildUnsupported',
        'This host runs a version of Windows older than Windows 10 and Windows Server 2016, so it can’t run Orca’s server. Use a host with a newer version of Windows, or a Linux or macOS host.'
      )
    case 'windows_no_extractor':
      return t(
        'auto.components.settings.sshHostServer.windowsNoExtractor',
        'This Windows host has neither tar.exe nor PowerShell’s Expand-Archive, so Orca can’t unpack its server there. Install Windows PowerShell 5.1 on the host, then connect again.'
      )
    default:
      return null
  }
}
