// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { makeAutomation } from '@/components/automations/automations-page-fixtures'
import type { Automation } from '../../../../shared/automations/automation-definition'
import type { AutomationCardDetailsController } from './automation-card-details-controller'
import { NativeChatAutomationCurrentDetails } from './NativeChatAutomationCurrentDetails'

// Explicit no-delivery must not read as delivery into each run; only an absent target does.

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function resultsRow(automation: Automation): string | null {
  act(() =>
    root.render(
      <NativeChatAutomationCurrentDetails
        automation={automation}
        runs={[]}
        source={{
          target: { kind: 'local' },
          sessionId: 'chat',
          itemId: 'receipt',
          automationId: automation.id,
          createdAt: automation.createdAt,
          botId: automation.bot?.botId
        }}
        owner={{ selector: { kind: 'self' } }}
        controller={{} as AutomationCardDetailsController}
        onEditInChat={null}
      />
    )
  )
  const label = [...container.querySelectorAll('dt')].find((dt) => dt.textContent === 'Results')
  return label?.nextElementSibling?.textContent ?? null
}

it.each([
  ['a project automation with no results target', undefined, 'In each run'],
  ['explicit no delivery', 'none', 'Nowhere'],
  ['chat delivery', 'chat', 'Chat'],
  ['thread delivery', 'thread', "The event's thread"]
] as const)('renders the Results row for %s', (_case, resultsTo, expected) => {
  const automation =
    resultsTo === undefined
      ? makeAutomation({ bot: undefined })
      : makeAutomation({ bot: { botId: 'bot', runsIn: 'new', resultsTo } })
  expect(resultsRow(automation)).toBe(expected)
})
