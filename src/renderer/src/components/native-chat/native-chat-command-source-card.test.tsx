import { i18n } from '@/i18n/i18n'
import fr from '@/i18n/locales/fr.json'
// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { render } from './native-chat-tooltip-test-harness'
import { useAppStore } from '@/store'
import { initialStore, resetSenderStore } from './native-chat-agent-sender.test-fixture'
import { orchestrationMailFixture } from '../../../../shared/agent-session/orchestration-mail.test-fixture'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import * as navigation from '@/lib/open-agent-message-sender'
import { MessageRow } from './NativeChatMessageRow'

beforeEach(resetSenderStore)
afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
  i18n.removeResourceBundle('fr', 'translation')
  vi.restoreAllMocks()
  useAppStore.setState(initialStore, true)
})
const row = (message: NativeChatMessage) => (
  <MessageRow
    message={message}
    expandSignal={false}
    onScrollMessageToTop={() => {}}
    runtimeContext={{ worktreeId: 'workspace', worktreePath: null, target: { kind: 'local' } }}
  />
)

it('routes saved external and declared own-command reports through background content while actual workers retain orchestration', () => {
  const actual = orchestrationMailFixture()
  const mail = actual.from.orchestration
  if (mail?.message !== 'mail-notice') {
    throw new Error('mail fixture')
  }
  const historical = {
    ...actual,
    id: 'historical',
    from: {
      ...actual.from,
      senders: [
        {
          name: null,
          party: { address: 'orca-bg-wake', terminalHandle: 'orca-bg-wake', orcaSessionId: null }
        }
      ],
      orchestration: {
        ...mail,
        messages: mail.messages.map((ref) => ({ ...ref, from: 'orca-bg-wake' }))
      }
    }
  }
  const { rerender } = render(row(historical))
  expect(screen.getByText('orca-bg-wake').closest('button')).toBeNull()
  expect(screen.getByText('Review complete')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Update from worker' })).toBeNull()
  expect(screen.queryByText('an agent')).toBeNull()
  const declared = {
    ...actual,
    mailDisplayReports: [
      {
        mailbox: mail.mailbox,
        messageId: 'msg_review',
        runId: 'run_review',
        from: 'term_worker',
        report: {
          version: 1 as const,
          kind: 'command' as const,
          result: { type: 'exit' as const, code: 7 }
        }
      }
    ]
  }
  rerender(row(declared))
  expect(screen.getByText('Exit 7')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Update from worker' })).toBeNull()
  rerender(row(actual))
  expect(screen.getByRole('button', { name: 'Update from worker' })).toBeInTheDocument()
})

it('preserves independently valid endpoint and actor actions in report attribution', () => {
  const open = vi.spyOn(navigation, 'openAgentMessageSender').mockResolvedValue(undefined)
  const actual = orchestrationMailFixture()
  const setup = {
    ...actual,
    from: {
      ...actual.from,
      senders: [
        {
          name: 'Setup',
          party: { address: 'term_worker', terminalHandle: 'term_worker', orcaSessionId: null }
        }
      ]
    }
  }
  const { rerender } = render(row(setup))
  fireEvent.click(screen.getByRole('button', { name: 'Setup' }))
  expect(open).toHaveBeenLastCalledWith(
    setup.from,
    setup.from.senders[0],
    'workspace',
    { kind: 'local' },
    undefined,
    'Setup'
  )
  const unnamed = {
    ...setup,
    from: { ...setup.from, senders: [{ ...setup.from.senders[0]!, name: null }] }
  }
  rerender(row(unnamed))
  expect(screen.queryByText('an agent')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))
  expect(open).toHaveBeenLastCalledWith(
    unnamed.from,
    unnamed.from.senders[0],
    'workspace',
    { kind: 'local' },
    undefined,
    'Terminal'
  )
  const mail = actual.from.orchestration
  if (mail?.message !== 'mail-notice') {
    throw new Error('mail fixture')
  }
  const mixed = {
    ...actual,
    from: {
      ...actual.from,
      senders: [
        ...actual.from.senders,
        {
          name: null,
          party: { address: 'external', terminalHandle: 'external', orcaSessionId: null }
        }
      ],
      orchestration: {
        ...mail,
        messages: [...mail.messages, { messageId: 'second', runId: 'run_review', from: 'external' }]
      }
    }
  }
  rerender(row(mixed))
  fireEvent.click(screen.getByRole('button', { name: 'Review worker' }))
  expect(open).toHaveBeenLastCalledWith(
    mixed.from,
    actual.from.senders[0],
    'workspace',
    { kind: 'local' },
    undefined,
    'Review worker'
  )
  expect(screen.getByText('external').closest('button')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Update from worker' })).toBeNull()
})

it('renders a localized observed command outcome in the existing background row', async () => {
  i18n.addResourceBundle('fr', 'translation', fr)
  await i18n.changeLanguage('fr')
  const message = orchestrationMailFixture()
  const mail = message.from.orchestration
  if (mail?.message !== 'mail-notice') {
    throw new Error('fixture')
  }
  render(
    row({
      ...message,
      mailDisplayReports: [
        {
          ...mail.messages[0]!,
          mailbox: mail.mailbox,
          report: { version: 1, kind: 'command', result: { type: 'exit', code: 7 } }
        }
      ]
    })
  )
  expect(screen.getByText('Code de sortie 7')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Update from worker' })).toBeNull()
})
