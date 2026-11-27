import { TEXT_GENERATION_FAILURE_COPY } from '../text-generation/text-generation-failure-copy'
import { escapeRegex } from '../text/regex-escaping'
import {
  BRANCH_NAME_ENVIRONMENT_FAILED_HEADLINE,
  BRANCH_PUBLISHED_CHECK_FAILED_HEADLINE,
  WORKSPACE_NAME_ENVIRONMENT_FAILED_HEADLINE
} from './branch-auto-rename-failure-headlines'

/** Why auto-naming failed, read back from the persisted error text (any build's wording). */
export type BranchAutoRenameFailureReason =
  | { kind: 'model-unavailable'; model: string; agent: string | null; accountTier: boolean }
  | { kind: 'timed-out'; seconds: number }
  | { kind: 'agent-missing'; agent: string }
  | { kind: 'usage-limit'; agent: string | null }
  | { kind: 'signed-out'; agent: string | null }
  | { kind: 'agent-failed'; agent: string }
  | { kind: 'no-agent' }
  | { kind: 'publish-check' }
  | { kind: 'environment' }
  | { kind: 'empty-name' }
  | { kind: 'unknown' }

type Copy = typeof TEXT_GENERATION_FAILURE_COPY

/** A copy template as an anchored pattern; each `{{slot}}` becomes a named group. */
function templatePattern(template: string): RegExp {
  const source = template
    .split(/(\{\{\w+\}\})/)
    .map((part) => {
      const slot = /^\{\{(\w+)\}\}$/.exec(part)?.[1]
      return slot ? `(?<${slot}>[\\s\\S]*?)` : escapeRegex(part)
    })
    .join('')
  return new RegExp(`^${source}`)
}

function matchCopy(error: string, code: keyof Copy): Record<string, string> | null {
  const match = templatePattern(TEXT_GENERATION_FAILURE_COPY[code]).exec(error)
  return match ? { ...match.groups } : null
}

// Codex's account-tier refusal; Orca's own "Model ... is not available" copy; any CLI naming a refused model.
const ACCOUNT_TIER_MODEL =
  /The '([^']+)' model is not supported when using (\w+) with a ChatGPT account/
const REFUSED_MODEL =
  /model[^.\n]{0,40}?['"`]([\w.:/-]+)['"`][^.\n]{0,60}?\b(?:does not exist|not found|not supported|not available|unknown model|invalid model)/i
const USAGE_LIMIT = /\b(?:usage limit|rate limit|quota|hit your limit|limit reached)\b/i
const SIGNED_OUT =
  /\b(?:not (?:logged|signed) in|please (?:log|sign) in|unauthori[sz]ed|invalid api key)\b/i

const NO_AGENT_CODES = [
  'sourceControlAgentUnsupported',
  'sourceControlCustomCommandEmpty',
  'commandTemplateEmptyBranchName',
  'agentCannotGenerateBranchName',
  'noModelForAgent',
  'planCustomCommandEmpty',
  'planAgentUnsupported'
] as const satisfies readonly (keyof Copy)[]

const AGENT_FAILED_CODES = [
  'cliFailedWithDetail',
  'cliFailed',
  'cliTerminatedWithDetail',
  'cliTerminated',
  'agentReportedError',
  'agentCouldNotStart',
  'agentFailedToStart',
  'outputTooLarge'
] as const satisfies readonly (keyof Copy)[]

export function branchAutoRenameFailureReason(error: string): BranchAutoRenameFailureReason {
  const text = error.trim()
  const accountTier = ACCOUNT_TIER_MODEL.exec(text)
  if (accountTier) {
    return {
      kind: 'model-unavailable',
      model: accountTier[1],
      agent: accountTier[2],
      accountTier: true
    }
  }
  const planModel = matchCopy(text, 'planModelUnavailable')
  if (planModel?.model) {
    return {
      kind: 'model-unavailable',
      model: planModel.model,
      agent: planModel.label || null,
      accountTier: false
    }
  }
  const timedOut = matchCopy(text, 'timedOut')
  if (timedOut && Number(timedOut.seconds) > 0) {
    return { kind: 'timed-out', seconds: Number(timedOut.seconds) }
  }
  const missing = matchCopy(text, 'agentBinaryNotFound')
  if (missing?.label) {
    return { kind: 'agent-missing', agent: missing.label }
  }
  if (text.startsWith(BRANCH_PUBLISHED_CHECK_FAILED_HEADLINE)) {
    return { kind: 'publish-check' }
  }
  if (
    text.startsWith(BRANCH_NAME_ENVIRONMENT_FAILED_HEADLINE) ||
    text.startsWith(WORKSPACE_NAME_ENVIRONMENT_FAILED_HEADLINE)
  ) {
    return { kind: 'environment' }
  }
  if (NO_AGENT_CODES.some((code) => matchCopy(text, code))) {
    return { kind: 'no-agent' }
  }
  if (/^Generated (?:branch|chat) name was empty/.test(text)) {
    return { kind: 'empty-name' }
  }
  const failedCode = AGENT_FAILED_CODES.find((code) => matchCopy(text, code))
  const agent = failedCode ? (matchCopy(text, failedCode)?.label ?? null) : null
  const refused = REFUSED_MODEL.exec(text)
  if (refused) {
    return { kind: 'model-unavailable', model: refused[1], agent, accountTier: false }
  }
  if (USAGE_LIMIT.test(text)) {
    return { kind: 'usage-limit', agent }
  }
  if (SIGNED_OUT.test(text)) {
    return { kind: 'signed-out', agent }
  }
  return agent ? { kind: 'agent-failed', agent } : { kind: 'unknown' }
}
