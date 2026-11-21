import { isRecord } from '../../../agent-status/child-work/agent-status-child-work-value-guards'
import { parseAgentHookJson } from '../../request-body'

export type AntigravityLaunchResult = {
  tool: 'invoke_subagent' | 'swarm'
  children: string[]
  applied?: true
}

const INVOKE_PREFIX = 'Created the following subagent:\n'
const INVOKE_FOOTER =
  '\nThe subagent will send you a message when it has completed its task or requires guidance.'

function isChildId(value: unknown): value is string {
  return typeof value === 'string' && /^[\w-]{1,128}$/.test(value)
}

export function readAntigravityLaunchResult(
  record: Record<string, unknown>
): AntigravityLaunchResult | undefined {
  if (
    record.source !== 'MODEL' ||
    record.type !== 'GENERIC' ||
    typeof record.content !== 'string'
  ) {
    return undefined
  }
  const content = record.content.replace(/^(?:(?:Created|Completed) At: [^\n]*\n)+/, '').trim()
  if (
    record.status === 'ERROR' &&
    /^Encountered error in step execution: subagent "[^"\n]+" not found or not allowed to be invoked$/.test(
      content
    )
  ) {
    return { tool: 'invoke_subagent', children: [] }
  }
  if (record.status !== 'DONE') {
    return undefined
  }
  if (content.startsWith(INVOKE_PREFIX)) {
    const end = content.indexOf(INVOKE_FOOTER, INVOKE_PREFIX.length)
    const result =
      end === -1 ? undefined : parseAgentHookJson(content.slice(INVOKE_PREFIX.length, end))
    if (isRecord(result) && isChildId(result.conversationId)) {
      return { tool: 'invoke_subagent', children: [result.conversationId] }
    }
    return undefined
  }
  const result = content.startsWith('{') ? parseAgentHookJson(content) : undefined
  if (isRecord(result) && result.status === 'added') {
    const { conversation_ids: ids, names } = result
    if (ids === undefined && typeof result.name === 'string' && isChildId(result.conversation_id)) {
      return { tool: 'swarm', children: [result.conversation_id] }
    }
    if (
      Array.isArray(ids) &&
      ids.length > 0 &&
      ids.every(isChildId) &&
      Array.isArray(names) &&
      names.length === ids.length &&
      new Set(ids).size === ids.length
    ) {
      return { tool: 'swarm', children: ids }
    }
  }
  return undefined
}
