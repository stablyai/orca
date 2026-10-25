import { useAppStore } from '@/store'
import type { CalmStatusView } from '@/hooks/use-calm-status-reveal'
import { RemoteRuntimeRecoveryCard } from './RemoteRuntimeRecoveryCard'
import { remoteRuntimeRecoveryCopy } from './remote-runtime-recovery-copy'
import {
  selectRemoteServerOutageCause,
  selectRuntimeServerName,
  selectRuntimeServerTailscaleHost
} from './remote-server-outage'

/**
 * The one notice for a server whose shared connection dropped and is retrying, in place of a
 * banner in every pane. The surface owns `reveal`, so its panes stay quiet for as long as this shows.
 */
export function RemoteServerOutageNotice({
  environmentId,
  reveal
}: {
  environmentId: string
  reveal: CalmStatusView
}): React.JSX.Element | null {
  const serverName = useAppStore((state) => selectRuntimeServerName(state, environmentId))
  const cause = useAppStore((state) => selectRemoteServerOutageCause(state, environmentId))
  const tailscaleHost = useAppStore((state) =>
    selectRuntimeServerTailscaleHost(state, environmentId)
  )
  if (!reveal.visible) {
    return null
  }
  const copy = remoteRuntimeRecoveryCopy(cause, serverName)
  return (
    <RemoteRuntimeRecoveryCard
      icon="retrying"
      data={{
        'data-remote-server-outage-notice': environmentId,
        'data-terminal-remote-runtime-recovery-cause': cause
      }}
      title={copy.title}
      body={copy.body}
      downSince={reveal.downSince}
      tailscaleHost={cause === 'connection-lost' ? tailscaleHost : null}
    />
  )
}
