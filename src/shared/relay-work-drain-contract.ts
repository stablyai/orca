import { SKILL_SSH_RELAY_CANCEL_UPLOAD_METHOD } from './skill-ssh-relay-contract'
import {
  RELAY_OWNER_RESET_METHOD,
  RELAY_PREPARED_RESET_RECOVERY_METHOD
} from './relay-owner-reset-contract'

// Why: a drain must still admit the requests and notifications that let in-flight work finish or cancel.
// Network-tunnel (T4) methods join these sets when their contract lands.
const drainRequests = new Set<string>([
  'relay.status',
  RELAY_OWNER_RESET_METHOD,
  RELAY_PREPARED_RESET_RECOVERY_METHOD,
  'fs.unwatchAndWait',
  'agent.cancelExec',
  // Why (not in #16741): it only retires an existing delivery and replays its proof on retry;
  // refusing it turns a provable client cancellation into an unverifiable one.
  'pty.cancelDelivery',
  SKILL_SSH_RELAY_CANCEL_UPLOAD_METHOD
])
const drainNotifications = new Set<string>([
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
