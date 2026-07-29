import type { EventProps } from '../../../shared/telemetry-events'

export type DirectSshReconnectProductProps = EventProps<'direct_ssh_reconnect_operation'>

export type DirectSshReconnectProductSink = (
  name: 'direct_ssh_reconnect_operation',
  props: DirectSshReconnectProductProps
) => void
