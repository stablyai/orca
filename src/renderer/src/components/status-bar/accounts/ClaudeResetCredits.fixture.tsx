import { getDefaultSettings } from '../../../../../shared/constants'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { ClaudeResetCreditOffer } from '../../../../../shared/agent-accounts/claude/claude-reset-credit-types'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { ProviderDetailsMenu } from '../usage/ProviderDetailsMenu'
import { ClaudeResetCredits } from './ClaudeResetCredits'

const offer: ClaudeResetCreditOffer = {
  account: { accountId: 'sample-account', target: { runtime: 'host', wslDistro: null } },
  identity: {
    email: 'alex@example.com',
    accountUuid: '4b31b3a5-867b-403a-8834-d8900820c18c',
    organizationUuid: '7bb9b6c6-ce31-4e30-8dd6-df4b23b4c5e8'
  },
  pendingRequestId: null,
  credits: {
    eligible: true,
    ineligibleReason: null,
    atLimit: true,
    nextGrantId: 'full-reset',
    cooldownUntil: null,
    grants: [
      {
        id: 'full-reset',
        label: 'One full limit reset',
        resetsTotal: 1,
        resetsLeft: 1,
        startsAt: null,
        endsAt: Date.now() + 20 * 86_400_000,
        clears: ['five_hour', 'seven_day'],
        paused: false,
        usableNow: true,
        useRequiresLimit: false,
        blocking: []
      }
    ]
  }
}
const limits: ProviderRateLimits = {
  provider: 'claude',
  updatedAt: Date.now(),
  status: 'ok',
  error: null,
  session: {
    usedPercent: 100,
    windowMinutes: 300,
    resetsAt: Date.now() + 7_200_000,
    resetDescription: null
  },
  weekly: {
    usedPercent: 64,
    windowMinutes: 10_080,
    resetsAt: Date.now() + 4 * 86_400_000,
    resetDescription: null
  }
}

function resetFixture(mode: 'before' | 'available' | 'skip' | 'confirm' | 'unknown') {
  let submitted = 0
  return defineFixture({
    width: 460,
    store: {
      settings: {
        ...getDefaultSettings('/fixture'),
        skipClaudeRateLimitResetConfirm: mode === 'skip'
      }
    },
    setup: () => {
      submitted = 0
      window.api.runtime.call = async ({ method }) => {
        if (method === 'accounts.consumeClaudeResetCredit') {
          submitted += 1
          return {
            id: 'reset-fixture',
            ok: true,
            _meta: { runtimeId: 'fixture' },
            result: {
              requestId: '97a2cb6b-6c8d-42ac-8fdc-c03597ad6d31',
              outcome: 'reset',
              verified: true,
              cleared: ['five_hour', 'seven_day'],
              cooldownUntil: null,
              credits: { ...offer.credits, grants: [] }
            }
          }
        }
        return { id: 'reset-fixture', ok: true, result: offer, _meta: { runtimeId: 'fixture' } }
      }
    },
    render: () => (
      <div className="flex h-[560px] items-end bg-background p-3">
        <ProviderDetailsMenu
          provider={limits}
          compact={false}
          iconOnly={false}
          open
          variant="account"
          ariaLabel="Claude usage"
          accountLabel="alex@example.com (Max)"
          panelFooter={
            mode === 'before' ? undefined : (
              <ClaudeResetCredits
                credits={mode === 'unknown' ? null : offer.credits}
                account={offer.account}
                owner={{ kind: 'local' }}
              />
            )
          }
        />
      </div>
    ),
    interact: async (frame) => {
      if (mode !== 'skip' && mode !== 'confirm') {
        return
      }
      const buttons = Array.from(
        frame.ownerDocument.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')
      )
      const button = buttons.at(-1)
      if (!button) {
        throw new Error('Reset-card action did not render')
      }
      button.click()
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
      if (
        mode === 'confirm' &&
        (submitted !== 0 || !frame.ownerDocument.querySelector('[role="checkbox"]'))
      ) {
        throw new Error('Reset must wait for confirmation and offer a skip preference')
      }
      if (
        mode === 'skip' &&
        (submitted !== 1 || frame.ownerDocument.querySelector('[role="dialog"]'))
      ) {
        throw new Error('Saved skip preference must submit once without opening a dialog')
      }
    }
  })
}

export const before = resetFixture('before')
export const available = resetFixture('available')
export const withoutConfirmation = resetFixture('skip')
export const confirmation = resetFixture('confirm')
export const unknown = resetFixture('unknown')
