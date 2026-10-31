// @vitest-environment happy-dom

import { act } from 'react'
import { afterEach, expect, it } from 'vitest'
import {
  api,
  installAutomationsPageHarness,
  renderPage,
  settleHostQueries
} from '../automations/automations-page-test-harness'
import { makeAutomation } from '../automations/automations-page-fixtures'
import { i18n } from '@/i18n/i18n'
import { AutomationFailureBadge } from './AutomationFailureBadge'

installAutomationsPageHarness()
afterEach(async () => {
  await act(async () => void (await i18n.changeLanguage('en')))
})

it('renders actual English and Spanish badge counts from scoped authority answers', async () => {
  const automation = makeAutomation()
  let count = 1
  api.automations.listScoped.mockImplementation(async () => ({
    automations: [automation],
    items: [{ automationId: automation.id, selector: { kind: 'self' }, unseenFailureCount: count }],
    orphanCount: 0
  }))
  await act(async () => void (await i18n.changeLanguage('en')))
  const { container } = await renderPage({ peer: <AutomationFailureBadge /> })
  await settleHostQueries()
  const badge = (label: string, expected: number) => {
    expect(container.querySelector(`[aria-label="${label}"]`)?.textContent).toBe(String(expected))
  }
  badge('1 unseen failed runs', 1)
  await act(async () => void (await i18n.changeLanguage('es')))
  badge('1 ejecución fallida sin ver', 1)
  await act(async () => {
    count = 2
    window.dispatchEvent(
      new CustomEvent('orca:automations-changed', {
        detail: { reason: 'run', selector: { kind: 'self' } }
      })
    )
  })
  await settleHostQueries()
  badge('2 ejecuciones fallidas sin ver', 2)
  await act(async () => void (await i18n.changeLanguage('en')))
  badge('2 unseen failed runs', 2)
})
