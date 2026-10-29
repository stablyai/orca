import { translate } from '@/i18n/i18n'
import { RemoteRuntimeRecoveryCard } from './RemoteRuntimeRecoveryCard'

/** A pane whose WSL distro is stopped: nothing restarts it on its own (E9); Start is the user's act. */
export function WslDistroStoppedCard({
  distro,
  unverifiable = false,
  onStart,
  data
}: {
  distro: string
  /** The running read gave no answer: say so rather than claim the distro stopped. */
  unverifiable?: boolean
  onStart: () => void
  data: Record<`data-${string}`, string>
}): React.JSX.Element {
  return (
    <RemoteRuntimeRecoveryCard
      icon="stopped"
      data={data}
      title={
        unverifiable
          ? translate(
              'components.native-chat.hostOutage.unverifiable',
              "Orca couldn't check whether {{distro}} is running",
              { distro }
            )
          : translate('components.native-chat.hostOutage.stopped', '{{distro}} is stopped', {
              distro
            })
      }
      action={{
        label: translate('components.native-chat.hostOutage.start', 'Start'),
        onClick: onStart
      }}
    />
  )
}
