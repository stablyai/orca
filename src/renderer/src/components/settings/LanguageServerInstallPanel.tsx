import { useCallback } from 'react'
import { translate } from '@/i18n/i18n'
import { OnboardingInlineCommandTerminal } from '../onboarding/OnboardingInlineCommandTerminal'
import { LANGUAGE_SERVER_CATALOG } from '../../../../shared/language-server-catalog'
import type { LanguageServerId } from '../../../../shared/language-server-types'
import {
  buildLanguageServerInstallCommand,
  installShellFamily
} from './language-server-install-command'

type Props = {
  repoPath: string
  serverId: LanguageServerId
  mode: 'install' | 'update'
  onFinished: (exitCode: number | null) => void
  onExit: () => void
}
const KEY = 'auto.components.settings.RepositoryLanguageServersSection'

export function LanguageServerInstallPanel({
  repoPath,
  serverId,
  mode,
  onFinished,
  onExit
}: Props): React.JSX.Element | null {
  const entry = LANGUAGE_SERVER_CATALOG[serverId]
  const isWindows = navigator.userAgent.includes('Windows')
  const prepareCommandForShell = useCallback(
    (command: string, shell: string | undefined) =>
      buildLanguageServerInstallCommand(
        command,
        repoPath,
        installShellFamily(shell, isWindows),
        shell
      ),
    [repoPath, isWindows]
  )
  if (entry.kind !== 'external') {
    return null
  }
  return (
    <OnboardingInlineCommandTerminal
      command={mode === 'install' ? entry.installCommand : entry.updateCommand}
      // Why: the inline terminal starts in ~, but version-manager shims must see the project's .ruby-version.
      prepareCommandForShell={prepareCommandForShell}
      title={translate(`${KEY}.installTitle`, 'Install {{server}}', { server: entry.label })}
      ariaLabel={translate(`${KEY}.installAria`, 'Language server install terminal')}
      terminalTopMarginPx={8}
      autoScrollIntoView={false}
      onCommandFinished={onFinished}
      onTerminalExit={onExit}
    />
  )
}
