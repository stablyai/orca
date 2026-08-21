import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  isJiraPayloadStreamMessage,
  JIRA_PAYLOAD_MAX_CHARS
} from '../../../shared/jira-payload-stream'
import { RuntimeRpcCallError } from './runtime-rpc-client'

type RuntimeJiraPayloadTarget = { kind: 'environment'; environmentId: string }

export async function readRuntimeJiraPayload<TResult>(
  target: RuntimeJiraPayloadTarget,
  method: string,
  params: unknown
): Promise<TResult> {
  const chunks: string[] = []
  let receivedChars = 0
  let unsubscribe: (() => void) | null = null
  let unsubscribeWhenReady = false

  const close = (): void => {
    if (unsubscribe) {
      unsubscribe()
    } else {
      unsubscribeWhenReady = true
    }
  }

  return new Promise<TResult>((resolve, reject) => {
    let settled = false
    const fail = (error: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      close()
      reject(error)
    }
    const finish = (): void => {
      if (settled) {
        return
      }
      settled = true
      close()
      try {
        resolve(JSON.parse(chunks.join('')) as TResult)
      } catch {
        reject(new Error('Remote Jira payload was not valid JSON.'))
      }
    }

    void window.api.runtimeEnvironments
      .subscribe(
        {
          selector: target.environmentId,
          method,
          params,
          timeoutMs: 60_000
        },
        {
          onResponse: (response) => {
            const rpcResponse = response as RuntimeRpcResponse<unknown>
            if (!rpcResponse.ok) {
              fail(new RuntimeRpcCallError(rpcResponse))
              return
            }
            const message = rpcResponse.result
            if (!isJiraPayloadStreamMessage(message)) {
              fail(new Error('Remote Jira payload stream returned an invalid message.'))
              return
            }
            if (message.type === 'end') {
              finish()
              return
            }
            receivedChars += message.content.length
            if (receivedChars > JIRA_PAYLOAD_MAX_CHARS) {
              fail(new Error('Remote Jira payload exceeded the transfer limit.'))
              return
            }
            chunks.push(message.content)
          },
          onError: fail,
          onClose: () => fail(new Error('Remote Jira payload stream closed before completion.'))
        }
      )
      .then((handle) => {
        unsubscribe = handle.unsubscribe
        if (unsubscribeWhenReady) {
          unsubscribe()
        }
      })
      .catch(fail)
  })
}
