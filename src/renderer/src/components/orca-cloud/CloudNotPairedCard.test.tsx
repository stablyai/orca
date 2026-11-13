// @vitest-environment happy-dom
// The waking overlay's not-linked card: one primary action ("Open cloud workspace…"), never next to
// the billing fix or Try again; a billing refusal keeps its own card without the picker button.
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { CloudWakeProgressEvent } from '../../../../shared/hosted-sandbox/cloud-workspace-api'
import { CloudWakingOverlay } from './CloudWakingOverlay'

afterEach(cleanup)

const noop = (): void => {}
const failed = (over: Partial<CloudWakeProgressEvent>): CloudWakeProgressEvent => ({
  workspaceId: 'ws',
  phase: 'failed',
  source: 'open',
  startedAt: 1,
  at: 2,
  ...over
})

function overlay(wake: CloudWakeProgressEvent): void {
  render(
    <CloudWakingOverlay
      wake={wake}
      workspaceName="Refund webhooks"
      autoFocus={false}
      onRetry={noop}
      onRestart={noop}
      onDismiss={noop}
    />
  )
}

const actionNames = (): string[] =>
  screen
    .getAllByRole('button')
    .map((b) => b.textContent?.trim() ?? '')
    .filter(Boolean)

describe('not linked to this computer', () => {
  it('offers only Open cloud workspace…, never Try again or Restart', () => {
    overlay(failed({ notPaired: true, message: 'This workspace is no longer linked.' }))
    expect(actionNames()).toEqual(['Open cloud workspace…'])
  })

  it('stays the not-linked card even if a billing denial rides along (one primary action)', () => {
    overlay(
      failed({
        notPaired: true,
        message: 'entitlement_denied',
        billingDenial: { reason: 'subscription_inactive' }
      })
    )
    expect(actionNames()).toEqual(['Open cloud workspace…'])
  })

  it('a billing refusal keeps its own card, with no picker button', () => {
    overlay(
      failed({ message: 'entitlement_denied', billingDenial: { reason: 'payment_past_due' } })
    )
    expect(screen.queryByRole('button', { name: 'Open cloud workspace…' })).toBeNull()
  })
})
