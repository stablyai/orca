// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { render } from './native-chat-tooltip-test-harness'
import { useAppStore } from '@/store'
import { i18n } from '@/i18n/i18n'
import fr from '@/i18n/locales/fr.json'
import { initialStore, resetSenderStore } from './native-chat-agent-sender.test-fixture'
import { orchestrationMailFixture } from '../../../../shared/agent-session/orchestration-mail.test-fixture'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { NativeChatAgentMessageCard } from './NativeChatAgentMessageCard'

beforeEach(resetSenderStore)
afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
  i18n.removeResourceBundle('fr', 'translation')
  useAppStore.setState(initialStore, true)
})

function card(message: NativeChatMessage) {
  return (
    <NativeChatAgentMessageCard
      message={message}
      from={message.from!}
      runtimeContext={{ worktreeId: 'workspace', worktreePath: null, target: { kind: 'local' } }}
      allowFileUriLinks={false}
      onRefolded={() => {}}
    />
  )
}

it.each([
  ['ci-notifier', 'en', 'Message from'],
  ['orca-bg-wake', 'fr', 'Message de']
] as const)(
  'shows %s as a command source alongside a real agent',
  async (address, locale, heading) => {
    i18n.addResourceBundle('fr', 'translation', fr)
    await i18n.changeLanguage(locale)
    const message = orchestrationMailFixture()
    const helper = {
      ...message,
      id: address,
      from: {
        ...message.from,
        senders: [{ name: null, party: { address, terminalHandle: address, orcaSessionId: null } }]
      }
    }
    const { container } = render(
      <>
        {card(helper)}
        {card(message)}
      </>
    )
    expect(screen.getByText(heading)).toBeInTheDocument()
    expect(screen.getByText(address).closest('button')).toBeNull()
    expect(container.querySelectorAll('.lucide-terminal')).toHaveLength(1)
    expect(screen.queryByText('an agent')).toBeNull()
    expect(screen.getByRole('button', { name: 'Review worker' })).toBeInTheDocument()
    expect(screen.getByText('Review worker')).toBeInTheDocument()
  }
)
