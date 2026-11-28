import { unrefTimer } from '../../timers/unref-timer'
import { isRpcResponse, type RpcResponse } from '../rpc/rpc-response-shape'
import type { RelayRequestPort } from '../relay/client/relay-resume-credential'

// Calls a Relay link makes for its own credential, kept out of the connection's id space.
const CREDENTIAL_CALL_PREFIX = 'relay-credential-'
const CREDENTIAL_CALL_TIMEOUT_MS = 30_000

type PendingCall = { resolve: (response: RpcResponse) => void; fail: (error: Error) => void }

/**
 * The credential calls a Relay link makes before its control connection may use it. They end with
 * the link: `failAll` rejects every call still waiting, so none outlives a dropped or closed link.
 */
export function createRelayCredentialCalls(
  deviceToken: string,
  send: (payload: string) => boolean
) {
  const pending = new Map<string, PendingCall>()
  let calls = 0
  const port: RelayRequestPort = {
    sendRequest: (method, params) =>
      new Promise((resolve, reject) => {
        const id = `${CREDENTIAL_CALL_PREFIX}${++calls}`
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`${method} timed out`))
        }, CREDENTIAL_CALL_TIMEOUT_MS)
        unrefTimer(timer)
        const settle = (): void => {
          clearTimeout(timer)
          pending.delete(id)
        }
        pending.set(id, {
          resolve: (response) => {
            settle()
            resolve(response)
          },
          fail: (error) => {
            settle()
            reject(error)
          }
        })
        if (!send(JSON.stringify({ id, deviceToken, method, params }))) {
          pending.get(id)?.fail(new Error('relay link closed'))
        }
      })
  }
  return {
    port,
    /** True when `plaintext` answered one of these calls; such frames are not the connection's. */
    answer(plaintext: string): boolean {
      if (pending.size === 0 || !plaintext.includes(CREDENTIAL_CALL_PREFIX)) {
        return false
      }
      let value: unknown
      try {
        value = JSON.parse(plaintext)
      } catch {
        return false
      }
      const call = isRpcResponse(value) ? pending.get(value.id) : undefined
      if (!call || !isRpcResponse(value)) {
        return false
      }
      call.resolve(value)
      return true
    },
    failAll(error: Error): void {
      for (const call of pending.values()) {
        call.fail(error)
      }
    }
  }
}
