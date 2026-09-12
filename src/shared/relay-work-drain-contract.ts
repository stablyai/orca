import { SKILL_SSH_RELAY_CANCEL_UPLOAD_METHOD } from './skill-ssh-relay-contract'
import {
  RELAY_NETWORK_TUNNEL_CLOSE_METHOD,
  RELAY_NETWORK_TUNNEL_FRAME_METHOD
} from './relay-network-tunnel-contract'
import {
  RELAY_OWNER_RESET_METHOD,
  RELAY_PREPARED_RESET_RECOVERY_METHOD
} from './relay-owner-reset-contract'

const drainRequests = new Set([
  RELAY_NETWORK_TUNNEL_CLOSE_METHOD,
  'relay.status',
  RELAY_OWNER_RESET_METHOD,
  RELAY_PREPARED_RESET_RECOVERY_METHOD,
  'fs.unwatchAndWait',
  'agent.cancelExec',
  SKILL_SSH_RELAY_CANCEL_UPLOAD_METHOD
])
const drainNotifications = new Set([
  RELAY_NETWORK_TUNNEL_FRAME_METHOD,
  'rpc.cancel',
  'git.responseAck',
  'git.cancelResponseStream',
  'fs.streamAck',
  'fs.cancelStream',
  'fs.unwatch',
  'pty.ackData',
  'pty.setDeliveryPaused'
])

export function allowsRelayWorkDuringDrain(method: string, notification = false): boolean {
  return (notification ? drainNotifications : drainRequests).has(method)
}
