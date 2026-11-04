// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { i18n } from '@/i18n/i18n'
import { agentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import { NativeChatNoticeRow } from './NativeChatNoticeRow'

function renderFailure(failure: ReturnType<typeof agentSessionFailureFact>, text: string) {
  render(
    <TooltipProvider>
      <NativeChatNoticeRow
        agentName="Claude"
        block={{ type: 'text', tone: 'error', text, failure }}
      />
    </TooltipProvider>
  )
}

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
})

it('renders a plugin input failure with its recovery in English and French', async () => {
  const failure = agentSessionFailureFact('pluginInputRequired', {
    detail: { text: 'blast-radius', audience: 'person' }
  })
  const text =
    'Claude stopped because the "blast-radius" plugin is waiting for input in a terminal pane. Disable the plugin for chat sessions, or run the task in a Claude terminal.'
  renderFailure(failure, text)
  expect(screen.getByText(text)).toBeInTheDocument()
  expect(screen.queryByText('Details')).not.toBeInTheDocument()
  cleanup()
  await i18n.changeLanguage('fr')
  renderFailure(failure, text)
  expect(
    screen.getByText(
      'Claude s’est arrêté car le plugin « blast-radius » attend une saisie dans un volet de terminal. Désactivez le plugin pour les sessions de chat ou exécutez la tâche dans un terminal Claude.'
    )
  ).toBeInTheDocument()
  expect(screen.queryByText('Détails')).not.toBeInTheDocument()
  cleanup()
  renderFailure(failure, 'Custom host recovery advice.')
  expect(screen.getByText('Custom host recovery advice.')).toBeInTheDocument()
})
