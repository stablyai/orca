// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import { NativeChatNoticeRow } from './NativeChatNoticeRow'
import {
  NativeChatOrcaStopContext,
  type NativeChatOrcaStopView
} from './native-chat-orca-stop-context'

afterEach(cleanup)

function hostView(wslDistro: string | null): NativeChatOrcaStopView {
  return {
    hostLabel: wslDistro ? `${wslDistro} (WSL)` : 'Local Mac',
    remoteHost: wslDistro !== null,
    wslDistro,
    continueAvailable: false,
    offeredTurnItemId: null,
    continueNow: () => {},
    usageLimitTurnItemId: null,
    continueUsageLimit: () => {}
  }
}

function renderRow(text: string, wslDistro: string | null) {
  const view = hostView(wslDistro)
  return render(
    <NativeChatOrcaStopContext.Provider value={view}>
      <NativeChatNoticeRow
        block={{ type: 'text', tone: 'error', text, failure: { kind: 'cliMissing' } }}
        agentName="Claude"
      />
    </NativeChatOrcaStopContext.Provider>
  )
}

const HOST_WORDS = agentSessionFailureWords(
  { kind: 'cliMissing' },
  { agentName: 'Claude', surface: 'row' }
).text

it('names the WSL distro the agent is missing from instead of "the computer running this chat"', () => {
  renderRow(HOST_WORDS, 'Ubuntu')
  expect(
    screen.getByText(
      "Claude isn't installed in the WSL distro Ubuntu. Install it inside Ubuntu, or check its Command in Settings → Agents."
    )
  ).toBeInTheDocument()
  expect(screen.queryByText(HOST_WORDS)).toBeNull()
})

it('keeps the host words off a WSL host', () => {
  renderRow(HOST_WORDS, null)
  expect(screen.getByText(HOST_WORDS)).toBeInTheDocument()
})

it('keeps host words that carry more than the plain not-installed sentence', () => {
  const withCommand = agentSessionFailureWords(
    { kind: 'cliMissing' },
    { agentName: 'Claude', command: 'compact', surface: 'row' }
  ).text
  renderRow(withCommand, 'Ubuntu')
  expect(screen.getByText(withCommand)).toBeInTheDocument()
})
