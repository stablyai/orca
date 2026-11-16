import type { RateLimitRuntimeTarget } from '../../agent-usage/rate-limits/rate-limit-types'

export type ClaudeResetCreditSettings = {
  skipClaudeRateLimitResetConfirm?: boolean
}

export type ClaudeResetGrant = {
  id: string
  label: string
  resetsTotal: number
  resetsLeft: number
  startsAt: number | null
  endsAt: number | null
  clears: string[]
  paused: boolean
  usableNow: boolean
  useRequiresLimit: boolean
  blocking: string[]
}

export type ClaudeResetCredits = {
  eligible: boolean
  ineligibleReason: string | null
  atLimit: boolean
  nextGrantId: string | null
  cooldownUntil: number | null
  grants: ClaudeResetGrant[]
}

export type ClaudeResetAccount = {
  accountId: string | null
  target: RateLimitRuntimeTarget
}

export type ClaudeResetIdentity = {
  email: string
  accountUuid: string
  organizationUuid: string
}

export type ClaudeResetCreditOffer = {
  account: ClaudeResetAccount
  identity: ClaudeResetIdentity
  credits: ClaudeResetCredits | null
  pendingRequestId: string | null
  previousResult?: ClaudeResetCreditResult | null
}

export type ClaudeResetCreditRequest = {
  account: ClaudeResetAccount
  identity: ClaudeResetIdentity
  grantId: string
  expectedResetsLeft: number
  expectedClears: string[]
  requestId: string
}

export type ClaudeResetCreditResult = {
  requestId: string
  outcome: 'reset' | 'already_used' | 'not_limited' | 'cooldown' | 'ineligible' | 'unknown'
  cleared: string[]
  cooldownUntil: number | null
  verified: boolean
  credits: ClaudeResetCredits | null
}

export function canUseClaudeResetGrant(
  credits: ClaudeResetCredits,
  grant: ClaudeResetGrant,
  now = Date.now()
): boolean {
  return (
    credits.eligible &&
    credits.nextGrantId === grant.id &&
    grant.resetsLeft > 0 &&
    grant.usableNow &&
    !grant.paused &&
    grant.blocking.length === 0 &&
    (grant.startsAt === null || grant.startsAt <= now) &&
    (grant.endsAt === null || grant.endsAt > now) &&
    (credits.cooldownUntil === null || credits.cooldownUntil <= now) &&
    (!grant.useRequiresLimit || credits.atLimit)
  )
}
