// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { agentSessionFailureFact } from '../../../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../../../shared/agent-session/failures/agent-session-failure-words'
import { NativeChatNoticeRow } from './NativeChatNoticeRow'
import { i18n } from '@/i18n/i18n'

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
})

it('localizes canonical failure facts while keeping host advice and diagnostics intact', async () => {
  await i18n.changeLanguage('fr')
  const diagnostic = 'Internal provider diagnostic: modelNotFound'
  const payload = {
    head: diagnostic,
    byteLength: diagnostic.length,
    digest: 'fixture',
    truncated: false
  }
  const kinds = [
    'modelUnavailable',
    'providerUnavailable',
    'providerSafetyStopped',
    'providerResponseFailed'
  ] as const
  const { container } = render(
    <>
      {kinds.map((kind) => (
        <NativeChatNoticeRow
          key={kind}
          agentName="Codex"
          block={{
            type: 'text',
            tone: 'failure',
            ...agentSessionFailureWords(agentSessionFailureFact(kind), {
              agentName: 'Codex',
              surface: 'row'
            }),
            providerFrame: { provider: 'codex', kind: 'notification:error', payload }
          }}
        />
      ))}
      <NativeChatNoticeRow
        agentName="Codex"
        block={{
          type: 'text',
          text: 'Custom host advice: use the enterprise model.',
          failure: agentSessionFailureFact('modelUnavailable')
        }}
      />
    </>
  )
  const visibleLines = [...container.querySelectorAll('p')]
    .map((node) => node.textContent)
    .join('\n')
  expect(visibleLines).toContain('le modèle sélectionné')
  expect(visibleLines).not.toContain('the selected model')
  expect(visibleLines).not.toContain(diagnostic)
  expect(screen.getByText('Custom host advice: use the enterprise model.')).toBeInTheDocument()
  const details = container.querySelector('details')!
  expect(details.open).toBe(false)
  fireEvent.click(details.querySelector('summary')!)
  expect(details.open).toBe(true)
  expect(details.querySelector('pre')).toHaveTextContent(diagnostic)
})
