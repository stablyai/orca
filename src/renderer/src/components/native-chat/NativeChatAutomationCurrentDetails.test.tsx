// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { makeAutomation } from '@/components/automations/automations-page-fixtures'
import type { Automation } from '../../../../shared/automations/automation-definition'
import { AutomationCardDetailsController } from './automation-card-details-controller'
import { NativeChatAutomationCurrentDetails } from './NativeChatAutomationCurrentDetails'

// Explicit no-delivery must not read as delivery into each run; only an absent target does.

const toasts = vi.hoisted((): unknown[] => [])
vi.mock('sonner', () => ({
  toast: {
    error: (message: unknown) => toasts.push(message),
    message: () => {},
    success: () => {}
  }
}))

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
  toasts.length = 0
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
        controller={new AutomationCardDetailsController(null)}
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

const flush = (): Promise<void> => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))

it.each([
  ['refused and recovered while hidden', 'hide', true, 0],
  ['refused and recovered after a true unmount', 'unmount', true, 0],
  ['failing on a host that never changed', 'hide', false, 1]
] as const)(
  'toasts a Pause the host rejects only when its binding still holds: %s',
  async (_case, leave, revoked, expected) => {
    const automation = makeAutomation({ id: 'a', createdAt: 10, enabled: true })
    const revokers = new Set<() => void>()
    const update = Promise.withResolvers<Automation>()
    const controller = new AutomationCardDetailsController({
      current: () => true,
      watch: (revoke) => {
        revokers.add(revoke)
        return () => revokers.delete(revoke)
      },
      read: async () => ({ status: 'ready', automation, owner: { selector: { kind: 'self' } } }),
      runs: async () => [],
      update: () => update.promise,
      remove: async () => true,
      run: async () => {}
    })
    controller.start()
    await flush()
    act(() =>
      root.render(
        <NativeChatAutomationCurrentDetails
          automation={automation}
          runs={[]}
          source={{
            target: { kind: 'environment', environmentId: 'E' },
            sessionId: 'chat',
            itemId: 'receipt',
            automationId: 'a',
            createdAt: 10,
            botId: undefined,
            pairingRevision: 7,
            runtimeId: 'W'
          }}
          owner={{ selector: { kind: 'self' } }}
          controller={controller}
          onEditInChat={null}
        />
      )
    )
    act(() => container.querySelector<HTMLButtonElement>('[role="switch"]')!.click())
    // The pane goes away with the write in flight: hidden by <Activity>, or unmounted for good.
    controller.dispose()
    if (leave === 'unmount') {
      act(() => root.unmount())
      root = createRoot(container)
    }
    if (revoked) {
      // An explicit refusal that clears again before the write settles.
      revokers.forEach((revoke) => revoke())
    }
    update.reject(new Error('The chat’s host changed.'))
    await flush()
    expect(toasts).toHaveLength(expected)
    expect(revokers.size).toBe(0)
  }
)
