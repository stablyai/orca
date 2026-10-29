import { translate } from '@/i18n/i18n'
import { startWslHostAndReloadProjects } from '@/lib/wsl-host-user-start'
import { RemoteRuntimeRecoveryCard } from './RemoteRuntimeRecoveryCard'

/**
 * In place of "Reconnecting…" on a pane whose WSL distro stopped: retries never boot it (E9), so
 * only the user's Start brings the terminal back.
 */
export function WslHostStoppedCard({
  environmentId,
  distro,
  onStarted
}: {
  environmentId: string
  distro: string
  onStarted: () => void
}): React.JSX.Element {
  return (
    <RemoteRuntimeRecoveryCard
      icon="stopped"
      data={{ 'data-terminal-wsl-host-stopped': environmentId }}
      title={translate('components.native-chat.hostOutage.stopped', '{{distro}} is stopped', {
        distro
      })}
      action={{
        label: translate('components.native-chat.hostOutage.start', 'Start'),
        onClick: () => {
          void startWslHostAndReloadProjects(environmentId).then((started) => {
            if (started) {
              onStarted()
            }
          })
        }
      }}
    />
  )
}
