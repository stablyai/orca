import { afterEach, describe, expect, it, vi } from 'vitest'

const toastError = vi.fn()
vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }))

import { billingCheckoutLink, billingPortalLink } from './billing-link'

function stubApi(api: Record<string, unknown>): void {
  vi.stubGlobal('window', { api: { orcaProfiles: api } })
}

afterEach(() => {
  toastError.mockReset()
  vi.unstubAllGlobals()
})

describe('billing "Copy link"', () => {
  it('returns the minted Portal URL without opening anything', async () => {
    const billingPortalLink$ = vi.fn(async () => ({
      status: 'ok' as const,
      url: 'https://billing.stripe.com/p/session/x'
    }))
    const billingOpenPortal = vi.fn()
    stubApi({ billingPortalLink: billingPortalLink$, billingOpenPortal })
    await expect(billingPortalLink()).resolves.toBe('https://billing.stripe.com/p/session/x')
    expect(billingOpenPortal).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })

  it('mints Checkout for the same order the button would open', async () => {
    const mint = vi.fn(async () => ({
      status: 'ok' as const,
      url: 'https://checkout.stripe.com/c/pay/cs_1'
    }))
    stubApi({ billingCheckoutLink: mint })
    const args = { plan: 'team', interval: 'year' as const, seats: 5 }
    await expect(billingCheckoutLink(args)).resolves.toBe('https://checkout.stripe.com/c/pay/cs_1')
    expect(mint).toHaveBeenCalledWith(args)
  })

  it('says why there is no link with the open path’s copy, then yields null', async () => {
    stubApi({ billingPortalLink: async () => ({ status: 'forbidden' }) })
    await expect(billingPortalLink()).resolves.toBeNull()
    expect(toastError).toHaveBeenCalledWith('Only an owner or admin can manage billing.')
  })

  it('treats a rejected IPC as a failed billing read', async () => {
    stubApi({
      billingPortalLink: async () => {
        throw new Error('boom')
      }
    })
    await expect(billingPortalLink()).resolves.toBeNull()
    expect(toastError).toHaveBeenCalledWith('Could not reach billing. Try again.')
  })
})
