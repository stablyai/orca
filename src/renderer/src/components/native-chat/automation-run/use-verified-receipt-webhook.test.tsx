// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { makeAutomation } from '@/components/automations/automations-page-fixtures'
import type { AutomationWebhookTrigger } from '../../../../../shared/automation-event-triggers'
import type { AutomationReceiptRead } from '../../../../../shared/automations/automation-receipt-read'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import type { NativeChatVisualOwner } from '../media/visuals/native-chat-visual-owner'
import type { AutomationReceiptSource } from '../automation-receipt-client'
import {
  useVerifiedReceiptWebhook,
  type VerifiedReceiptWebhook
} from './use-verified-receipt-webhook'

// Setup's live controls need the chat's own host to confirm the receipt, under the same pairing.

type Fixture = {
  reads: PromiseWithResolvers<AutomationReceiptRead>[]
  current: boolean
  repairListeners: Set<(ids: readonly string[]) => void>
  retireListeners: Set<(ids: readonly string[]) => void>
}
const fixture = vi.hoisted((): Fixture => ({
  reads: [],
  current: true,
  repairListeners: new Set(),
  retireListeners: new Set()
}))
vi.mock('../automation-receipt-client', () => ({
  captureAutomationReceiptSource: (
    owner: NativeChatVisualOwner | null,
    itemId: string | undefined,
    saved: AutomationSaved
  ): AutomationReceiptSource | null =>
    owner && itemId
      ? {
          target: owner.target,
          sessionId: owner.sessionId,
          itemId,
          automationId: saved.automation.id,
          createdAt: 42,
          botId: saved.automation.bot?.botId,
          pairingRevision: 1,
          runtimeId: 'runtime-1'
        }
      : null,
  automationReceiptSourceCurrent: () => fixture.current,
  // The real watch's contract: re-pair or retirement of this environment revokes, others don't.
  watchAutomationReceiptHost: (source: AutomationReceiptSource, revoke: () => void) => {
    const leave = (ids: readonly string[]): void => {
      if (source.target.kind === 'environment' && ids.includes(source.target.environmentId)) {
        revoke()
      }
    }
    fixture.repairListeners.add(leave)
    fixture.retireListeners.add(leave)
    return () => {
      fixture.repairListeners.delete(leave)
      fixture.retireListeners.delete(leave)
    }
  },
  readAutomationReceipt: () => {
    const read = Promise.withResolvers<AutomationReceiptRead>()
    fixture.reads.push(read)
    return read.promise
  }
}))

type AutomationSaved = NonNullable<NativeChatMessage['automationSaved']>

const webhookRule = (id: string): AutomationWebhookTrigger => ({
  id,
  source: 'webhook',
  event: 'call',
  rev: 1
})
const hookRule = webhookRule('wh-wh_abcdefgh12345678')
const otherRule = webhookRule('wh-wh_zzzzzzzz87654321')
const owner: NativeChatVisualOwner = {
  target: { kind: 'environment', environmentId: 'E' },
  sessionId: 'chat-on-W',
  tabId: 'chat-tab',
  worktreeId: 'project-Y'
}
const receipt = (overrides: Partial<AutomationSaved['automation']> = {}): AutomationSaved => ({
  change: 'created',
  automation: {
    id: 'hooked',
    name: 'Hooked',
    enabled: true,
    nextRunAt: 0,
    updatedAt: 1,
    dtstart: 0,
    rrule: '',
    workspaceId: null,
    on: [hookRule],
    ...overrides
  }
})
const ready = (on = [hookRule]): AutomationReceiptRead => ({
  status: 'ready',
  automation: makeAutomation({ id: 'hooked', createdAt: 42, on }),
  owner: { selector: { kind: 'self' } }
})

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
let verified: VerifiedReceiptWebhook | null = null
let result: string | null = null

function Probe({ saved, shortened = false }: { saved: AutomationSaved; shortened?: boolean }) {
  verified = useVerifiedReceiptWebhook(owner, 'receipt', saved, shortened)
  result = verified?.hookId ?? null
  return null
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  fixture.reads.length = 0
  fixture.current = true
  fixture.repairListeners.clear()
  fixture.retireListeners.clear()
  verified = null
  result = null
})

async function answer(read: AutomationReceiptRead | Error): Promise<void> {
  await act(async () => {
    const pending = fixture.reads.at(-1)!
    if (read instanceof Error) {
      pending.reject(read)
    } else {
      pending.resolve(read)
    }
    await pending.promise.catch(() => {})
  })
}

it('offers Setup only once the host confirms this receipt as its webhook automation', async () => {
  act(() => root.render(<Probe saved={receipt()} />))
  expect(result).toBeNull()
  expect(fixture.reads).toHaveLength(1)
  await answer(ready())
  expect(result).toBe('wh_abcdefgh12345678')
})

it.each([
  ['a mismatched receipt', { status: 'mismatch' }],
  ['an unverifiable origin', { status: 'unverified' }],
  ['a missing definition', { status: 'missing' }],
  ['a different hook on the host', ready([otherRule])],
  ['a failed read', new Error('host unreachable')]
] as const)('keeps %s a saved receipt', async (_case, read) => {
  act(() => root.render(<Probe saved={receipt()} />))
  await answer(read)
  expect(result).toBeNull()
})

it('withdraws Setup when the pairing that confirmed it is replaced', async () => {
  act(() => root.render(<Probe saved={receipt()} />))
  await answer(ready())
  expect(result).toBe('wh_abcdefgh12345678')
  fixture.current = false
  act(() => fixture.repairListeners.forEach((listener) => listener(['E'])))
  expect(result).toBeNull()
})

it('withdraws Setup when its host is retired, before the registry says so', async () => {
  act(() => root.render(<Probe saved={receipt()} />))
  await answer(ready())
  expect(result).toBe('wh_abcdefgh12345678')
  // Retirement is announced while the old revision still reads as current.
  act(() => fixture.retireListeners.forEach((listener) => listener(['E'])))
  expect(result).toBeNull()
})

it('ignores another host’s re-pair or retirement', async () => {
  act(() => root.render(<Probe saved={receipt()} />))
  await answer(ready())
  act(() => fixture.repairListeners.forEach((listener) => listener(['other'])))
  act(() => fixture.retireListeners.forEach((listener) => listener(['other'])))
  expect(result).toBe('wh_abcdefgh12345678')
})

it('hands Setup the confirming host pinned to its pairing and runtime, and the receipt’s bot', async () => {
  act(() => root.render(<Probe saved={receipt({ bot: { botId: 'bot-R' } })} />))
  await answer(ready())
  expect(verified).toMatchObject({
    hookId: 'wh_abcdefgh12345678',
    botId: 'bot-R',
    target: {
      kind: 'environment',
      environmentId: 'E',
      binding: { pairingRevision: 1, runtimeId: 'runtime-1' }
    }
  })
  const { target } = verified!
  const binding = target.kind === 'environment' ? target.binding : undefined
  expect(binding?.current()).toBe(true)
  // The binding follows the confirming source, so a control acting later sees the host change.
  fixture.current = false
  expect(binding?.current()).toBe(false)
})

it('ignores a confirmation that lands after the pairing changed', async () => {
  act(() => root.render(<Probe saved={receipt()} />))
  fixture.current = false
  await answer(ready())
  expect(result).toBeNull()
})

it.each([
  ['a wait', receipt({ once: {} }), false],
  ['a shortened body', receipt(), true],
  ['a non-webhook automation', receipt({ on: [] }), false]
] as const)('reads nothing and offers no Setup for %s', (_case, saved, shortened) => {
  act(() => root.render(<Probe saved={saved} shortened={shortened} />))
  expect(fixture.reads).toHaveLength(0)
  expect(result).toBeNull()
})

it('does not re-read when the transcript hands over an equal saved body', async () => {
  act(() => root.render(<Probe saved={receipt()} />))
  await answer(ready())
  act(() => root.render(<Probe saved={receipt()} />))
  expect(fixture.reads).toHaveLength(1)
  expect(result).toBe('wh_abcdefgh12345678')
})
