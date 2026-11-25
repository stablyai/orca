import { RemoteRuntimeClientError } from '../remote-runtime-client-error'
import { parseRemoteRuntimeJsonText } from './remote-runtime-request-frames'
import { RuntimeRpcEnvelopeSchema, type RuntimeRpcResponse } from '../rpc/runtime-rpc-envelope'
import {
  RuntimeRpcStagedReplyHandleSchema,
  RUNTIME_RPC_REPLY_STAGED_CODE,
  type RuntimeRpcReadStagedReplyParams,
  type RuntimeRpcStagedReplyPart
} from '../rpc/runtime-rpc-staged-reply'

/** Swaps a `reply_staged` answer for the reply it names, read in parts; other answers pass through. */
export async function readRuntimeRpcStagedReply<TResult>(
  response: RuntimeRpcResponse<TResult>,
  readPart: (
    params: RuntimeRpcReadStagedReplyParams
  ) => Promise<RuntimeRpcResponse<RuntimeRpcStagedReplyPart>>
): Promise<RuntimeRpcResponse<TResult>> {
  if (response.ok || response.error.code !== RUNTIME_RPC_REPLY_STAGED_CODE) {
    return response
  }
  const parsedHandle = RuntimeRpcStagedReplyHandleSchema.safeParse(response.error.data)
  if (!parsedHandle.success) {
    throw invalidStagedReply()
  }
  const handle = parsedHandle.data
  const parts: string[] = []
  let offset = 0
  while (offset < handle.length) {
    const part = await readPart({ replyId: handle.replyId, offset })
    if (!part.ok) {
      return part
    }
    const text = part.result?.text
    if (typeof text !== 'string' || text.length === 0 || offset + text.length > handle.length) {
      throw invalidStagedReply()
    }
    parts.push(text)
    offset += text.length
  }
  let raw: unknown
  try {
    raw = parseRemoteRuntimeJsonText(parts.join(''))
  } catch {
    throw invalidStagedReply()
  }
  const parsed = RuntimeRpcEnvelopeSchema.safeParse(raw)
  if (!parsed.success || '_keepalive' in parsed.data || parsed.data.id !== response.id) {
    throw invalidStagedReply()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the envelope is validated; its result type is the caller's claim, as for a one-frame reply.
  return parsed.data as RuntimeRpcResponse<TResult>
}

function invalidStagedReply(): RemoteRuntimeClientError {
  return new RemoteRuntimeClientError(
    'invalid_runtime_response',
    'Remote Orca runtime returned an invalid staged reply.'
  )
}
