import { createElement } from 'react'
import type * as ReactModule from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

vi.mock('@/lib/agent-catalog', async () => {
  const ReactActual = await vi.importActual<typeof ReactModule>('react')
  return {
    AgentIcon: ({ agent }: { agent: string }) =>
      ReactActual.createElement('span', { 'data-agent-icon': agent })
  }
})

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) => {
    let result = fallback
    for (const [key, value] of Object.entries(values ?? {})) {
      result = result.replace(`{{${key}}}`, value)
    }
    return result
  }
}))

const mocks = vi.hoisted((): { rateLimits: Record<string, unknown> } => ({
  rateLimits: {}
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      refreshRateLimits: async () => {},
      settingsSearchQuery: '',
      rateLimits: mocks.rateLimits
    })
}))

import { CommandCodeAccountsSection } from './CommandCodeAccountsSection'

function commandCodeUsage(overrides: Partial<ProviderRateLimits> = {}): ProviderRateLimits {
  return {
    provider: 'command-code',
    session: { usedPercent: 50, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: { usedPercent: 10, windowMinutes: 10080, resetsAt: null, resetDescription: null },
    monthly: {
      usedPercent: 20,
      windowMinutes: 43_200,
      resetsAt: Date.parse('2026-11-18T08:14:41.000Z'),
      resetDescription: null
    },
    extraUsage: {
      enabled: true,
      disabledReason: null,
      resetsAt: null,
      unit: 'credits',
      balance: 80,
      unlimited: false
    },
    planType: 'GOAT',
    updatedAt: Date.parse('2026-10-18T09:00:00.000Z'),
    error: null,
    status: 'ok',
    ...overrides
  }
}

function render(): string {
  return renderToStaticMarkup(createElement(CommandCodeAccountsSection))
}

beforeEach(() => {
  mocks.rateLimits = {}
})

describe('CommandCodeAccountsSection', () => {
  it('teaches where to sign in when this machine has no CLI login', () => {
    const html = render()

    expect(html).toContain('id="accounts-command-code"')
    expect(html).toContain('Not signed in')
    expect(html).toContain('cmd login')
    // Why: refresh is the step the copy asks for after `cmd login`, so the button
    // must stay enabled while no credential is known yet. React renders the
    // attribute as `disabled=""`; the class list's `disabled:` variants differ.
    expect(html).not.toMatch(/\sdisabled=""/)
  })

  it('shows the CLI-owned login as read-only state, not an editable key', () => {
    mocks.rateLimits = { commandCodeAuthConfigured: true, commandCode: commandCodeUsage() }
    const html = render()

    expect(html).toContain('Signed in')
    expect(html).toContain('COMMAND_CODE_API_KEY')
    expect(html).toContain('~/.commandcode/auth.json')
    // Why: the key does travel to the provider's API for the usage request, so the
    // copy must not claim it stays on the machine.
    expect(html).toContain('keeps the key in the main process')
    expect(html).not.toContain('never leaves this machine')
    expect(html).not.toContain('type="password"')
  })

  it('shows the same windows, credits, renewal, and plan as the CLI overlay', () => {
    mocks.rateLimits = { commandCodeAuthConfigured: true, commandCode: commandCodeUsage() }
    const html = render()

    expect(html).toContain('50%')
    expect(html).toContain('5-hour')
    expect(html).toContain('Weekly')
    expect(html).toContain('Monthly')
    expect(html).toContain('80 credits available')
    expect(html).toContain('Renews')
    expect(html).toContain('Plan: GOAT')
  })

  it('keeps the last error visible beside the signed-in state', () => {
    mocks.rateLimits = {
      commandCodeAuthConfigured: true,
      commandCode: commandCodeUsage({
        status: 'error',
        error: 'Command Code usage request failed (500)'
      })
    }
    const html = render()

    expect(html).toContain('Command Code usage request failed (500)')
  })
})
