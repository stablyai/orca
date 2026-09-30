import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { SettingsSwitchRow } from './SettingsFormControls'

// Why hidden on Windows: the OpenSSH agent there is a fixed named pipe a shell cannot redirect.
export function SshLoginShellAgentSetting(): React.JSX.Element | null {
  const enabled = useAppStore((s) => s.settings?.sshUseLoginShellAgent === true)
  const updateSettings = useAppStore((s) => s.updateSettings)
  if (navigator.userAgent.includes('Windows')) {
    return null
  }
  const label = translate(
    'auto.components.settings.SshPane.loginShellAgent',
    'Use SSH agent from login shell'
  )
  return (
    <SettingsSwitchRow
      label={label}
      description={translate(
        'auto.components.settings.SshPane.loginShellAgentHelp',
        'Use the SSH_AUTH_SOCK your shell profile sets (1Password, Secretive, gpg-agent) for SSH logins and agent forwarding, instead of the one Orca was launched with. Applies to the next connection.'
      )}
      checked={enabled}
      onChange={() => updateSettings({ sshUseLoginShellAgent: !enabled })}
    />
  )
}
