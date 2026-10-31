// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { projectStructuredItemsToNativeChat } from '../../../../shared/structured-agent-session-projection'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import type { AgentJournalStatusItem } from '../../../../shared/agent-session-journal-types'
import { isAdmissibleAgentJournalItemBody } from '../../../../shared/agent-session-journal-schemas'
import { TooltipProvider } from '@/components/ui/tooltip'
import { MessageRow } from './NativeChatMessageRow'
import { NativeChatNoticeRow } from './NativeChatNoticeRow'
import { useAppStore } from '@/store'
import { i18n } from '@/i18n/i18n'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import { agentSessionFailureFact } from '../../../../shared/agent-session-failure'
import {
  NativeChatOrcaStopContext,
  type NativeChatOrcaStopView
} from './native-chat-orca-stop-context'

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
})

it('keeps a skipped compaction warning truthful instead of showing the success separator', () => {
  renderStatus({
    kind: 'status',
    tone: 'warning',
    text: 'Nothing to compact (session too small)',
    presentation: 'compaction-skipped'
  })
  expect(screen.getByText('Nothing to compact (session too small)')).toBeInTheDocument()
  expect(screen.queryByText('Context compacted')).toBeNull()
})

type ContinueOffer = Pick<NativeChatOrcaStopView, 'offeredTurnItemId' | 'continueNow'> &
  Partial<Pick<NativeChatOrcaStopView, 'usageLimitTurnItemId' | 'continueUsageLimit'>>

function orcaStopView(
  hostLabel: string | null,
  continueAvailable: boolean,
  remoteHost: boolean,
  offer: ContinueOffer
): NativeChatOrcaStopView {
  return {
    hostLabel,
    remoteHost,
    continueAvailable,
    usageLimitTurnItemId: null,
    continueUsageLimit: () => {},
    ...offer
  }
}

const NO_OFFER = { offeredTurnItemId: null, continueNow: () => {} }

function renderStatus(
  body: AgentJournalStatusItem,
  hostLabel: string | null = null,
  continueAvailable = false,
  remoteHost = false,
  agentName?: string,
  offer: ContinueOffer = NO_OFFER
) {
  const [message] = projectStructuredItemsToNativeChat([
    {
      itemId: 'notice',
      sequence: 1,
      revision: 1,
      observedAt: 1,
      body,
      turnScope: { kind: 'turn', turnItemId: 'cut-turn' }
    }
  ])
  const view = orcaStopView(hostLabel, continueAvailable, remoteHost, offer)
  return render(
    <TooltipProvider>
      <NativeChatOrcaStopContext.Provider value={view}>
        <MessageRow
          message={message!}
          agentName={agentName}
          expandSignal={false}
          onScrollMessageToTop={vi.fn()}
        />
      </NativeChatOrcaStopContext.Provider>
    </TooltipProvider>
  )
}

const LEGACY_TEXT =
  'Codex stopped while this response was in progress. You can continue in this conversation.'

function orcaStopRow(cause: string): AgentJournalStatusItem {
  return {
    kind: 'status',
    text: LEGACY_TEXT,
    tone: 'error',
    presentation: 'orca-stop',
    orcaStop: { cause }
  }
}

describe('the row an Orca stop leaves', () => {
  it.each([
    ['update', 'Orca on studio-mac restarted for an update while this response was in progress.'],
    ['quit', 'Orca on studio-mac was closed while this response was in progress.'],
    ['crash', 'Orca on studio-mac stopped unexpectedly while this response was in progress.']
  ])('names a %s and the machine, muted', (cause, sentence) => {
    renderStatus(orcaStopRow(cause), 'studio-mac')
    const row = screen.getByText(`${sentence} You can continue in this conversation.`)
    expect(row.parentElement?.parentElement).toHaveClass('text-chat-foreground-faint')
    expect(screen.queryByText(LEGACY_TEXT)).toBeNull()
  })

  it('leaves the way on to Continue wherever its host can continue a cut', () => {
    renderStatus(orcaStopRow('update'), 'studio-mac', true)
    expect(
      screen.getByText(
        'Orca on studio-mac restarted for an update while this response was in progress.'
      )
    ).toBeInTheDocument()
  })

  it('carries Continue on the cut it is offered for, and only there', () => {
    const continueNow = vi.fn()
    renderStatus(orcaStopRow('quit'), 'studio-mac', true, false, undefined, {
      offeredTurnItemId: 'cut-turn',
      continueNow
    })
    const sentence = screen.getByText(
      'Orca on studio-mac was closed while this response was in progress.'
    )
    const button = screen.getByRole('button', { name: 'Continue' })
    expect(sentence.parentElement).toContainElement(button)
    fireEvent.click(button)
    expect(continueNow).toHaveBeenCalledOnce()
    cleanup()

    renderStatus(orcaStopRow('quit'), 'studio-mac', true, false, undefined, {
      offeredTurnItemId: 'another-turn',
      continueNow
    })
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
  })

  it("says a remote host's Orca stopped, not that it was closed", () => {
    renderStatus(orcaStopRow('quit'), 'QA SSH', true, true)
    expect(
      screen.getByText('Orca on QA SSH stopped while this response was in progress.').parentElement
        ?.parentElement
    ).toHaveClass('text-chat-foreground-faint')
    expect(screen.queryByText(/was closed/)).toBeNull()
  })

  it("keeps this desktop's quit as closed", () => {
    renderStatus(orcaStopRow('quit'), 'studio-mac', true, false)
    expect(
      screen.getByText('Orca on studio-mac was closed while this response was in progress.')
    ).toBeInTheDocument()
  })

  it.each([
    ['update', 'Orca on QA SSH restarted for an update while this response was in progress.'],
    ['crash', 'Orca on QA SSH stopped unexpectedly while this response was in progress.']
  ])("keeps a remote host's %s words", (cause, sentence) => {
    renderStatus(orcaStopRow(cause), 'QA SSH', true, true)
    expect(screen.getByText(sentence)).toBeInTheDocument()
  })

  it('stays neutral, naming the cause, as a reader that re-presented it neutral hands it on', () => {
    const represented: AgentJournalStatusItem = {
      kind: 'status',
      text: 'This response was interrupted. You can continue in this conversation.',
      tone: 'notice',
      presentation: 'orca-stop',
      orcaStop: { cause: 'crash' }
    }
    renderStatus(represented, 'studio-mac', true)
    expect(
      screen.getByText(
        'Orca on studio-mac stopped unexpectedly while this response was in progress.'
      ).parentElement?.parentElement
    ).toHaveClass('text-chat-foreground-faint')
    cleanup()
    renderStatus(represented, null, true)
    expect(
      screen.getByText('This response was interrupted. You can continue in this conversation.')
        .parentElement?.parentElement
    ).toHaveClass('text-chat-foreground-faint')
  })

  it('keeps the host words for a cause this build does not know', () => {
    renderStatus(orcaStopRow('power-loss'), 'studio-mac')
    expect(screen.getByText(LEGACY_TEXT)).toBeInTheDocument()
  })

  it('keeps the host words when the chat has no machine to name, muted all the same', () => {
    renderStatus(orcaStopRow('update'), null)
    expect(screen.getByText(LEGACY_TEXT).parentElement?.parentElement).toHaveClass(
      'text-chat-foreground-faint'
    )
  })

  it('calls a paired server with no name the remote server, so its words match the button', () => {
    renderStatus(orcaStopRow('update'), null, true, true)
    expect(
      screen.getByText(
        'Orca on the remote server restarted for an update while this response was in progress.'
      )
    ).toBeInTheDocument()
    expect(screen.queryByText(LEGACY_TEXT)).toBeNull()
  })

  it('keeps the host words for a stop Orca did not cause', () => {
    const { orcaStop: _orcaStop, presentation: _presentation, ...agentExit } = orcaStopRow('update')
    renderStatus(agentExit, 'studio-mac')
    expect(screen.getByText(LEGACY_TEXT).parentElement?.parentElement).toHaveClass(
      'text-destructive'
    )
  })
})

describe('the row a usage limit leaves', () => {
  const resetsAt = new Date(2026, 9, 18, 15, 0).getTime()
  const row = {
    kind: 'status',
    tone: 'warning',
    text: 'Claude hit its session limit. Send a message once it resets to continue.',
    failure: { kind: 'usageLimitReached', usageLimit: { window: 'session', resetsAt } }
  } as const

  it.each([
    ['future', resetsAt],
    ['past', new Date(2026, 9, 18, 10, 0).getTime()],
    ['unknown', undefined]
  ] as const)('shows a %s reset without a continuation action or instruction', (_state, reset) => {
    vi.useFakeTimers({ now: new Date(2026, 9, 18, 12, 30), toFake: ['Date'] })
    try {
      renderStatus(
        {
          kind: 'status',
          tone: 'warning',
          ...agentSessionFailureWords(
            agentSessionFailureFact('usageLimitReached', {
              usageLimit: { window: 'session', ...(reset === undefined ? {} : { resetsAt: reset }) }
            }),
            { agentName: 'Claude', surface: 'row' }
          )
        },
        null,
        false,
        false,
        'Claude',
        { ...NO_OFFER, usageLimitTurnItemId: 'cut-turn', continueUsageLimit: vi.fn() }
      )
      const clock =
        reset === undefined
          ? null
          : new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(reset)
      expect(
        screen.getByText(
          clock === null
            ? 'Claude hit its session limit.'
            : `Claude hit its session limit. It resets at ${clock}.`
        )
      ).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
      expect(screen.queryByText(/Send a message once it resets/)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['typed', 'text-only', 'unknown'] as const)(
    'renders historical usage-limit text with a %s fact',
    (fact) => {
      const historicalRow: unknown =
        fact === 'text-only'
          ? { ...row, failure: undefined }
          : fact === 'unknown'
            ? {
                ...row,
                failure: {
                  ...row.failure,
                  kind: 'usageLimitReached' as const,
                  futureLimit: true
                }
              }
            : row
      if (!isAdmissibleAgentJournalItemBody(historicalRow) || historicalRow.kind !== 'status') {
        throw new Error('Historical status fixture was not admitted')
      }
      if (fact === 'unknown') {
        expect(historicalRow.failure).toEqual({ ...row.failure, futureLimit: true })
      }
      renderStatus(historicalRow, null, false, false, 'Claude')
      if (fact === 'typed') {
        expect(
          screen.getByText(/^Claude hit its session limit\. It resets at \S.*\.$/u)
        ).toBeInTheDocument()
        expect(screen.queryByText(/Send a message once it resets/)).toBeNull()
      } else {
        expect(screen.getByText(row.text)).toBeInTheDocument()
      }
      expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
    }
  )
})

describe('notice rows', () => {
  it('keeps unmatched host auth wording and its next step', async () => {
    await i18n.changeLanguage('fr')
    const text = 'Use the host-specific sign-in page, then run /compact again.'
    render(
      <NativeChatNoticeRow
        block={{ type: 'text', tone: 'error', text, failure: { kind: 'notSignedIn' } }}
        agentName="Grok"
      />
    )
    expect(screen.getByText(text)).toBeInTheDocument()
  })

  it.each(['providerStartFailed', 'notSignedIn'] as const)(
    'keeps the host /compact retry instruction for %s',
    (kind) => {
      const words = agentSessionFailureWords(
        { kind },
        { agentName: 'Grok', command: 'compact', surface: 'row' }
      )
      renderStatus({ kind: 'status', tone: 'error', ...words }, null, false, false, 'Grok')
      expect(screen.getByText(words.text)).toBeInTheDocument()
      expect(screen.getByText(/Run \/compact again\./)).toBeInTheDocument()
      expect(screen.queryByText(/send your message again/i)).toBeNull()
    }
  )
  it('updates a mounted auth row when the reader changes language', async () => {
    renderStatus(
      {
        kind: 'status',
        tone: 'error',
        ...agentSessionFailureWords({ kind: 'notSignedIn' }, { agentName: 'Grok', surface: 'row' })
      },
      null,
      false,
      false,
      'Grok'
    )
    expect(
      screen.getByText('Sign in to Grok with `grok login` on the computer running this chat.')
    ).toBeInTheDocument()
    await act(() => i18n.changeLanguage('fr'))
    expect(
      screen.getByText(
        'Connectez-vous à Grok avec `grok login` sur l’ordinateur qui exécute ce chat.'
      )
    ).toBeInTheDocument()
  })
  it.each([
    ['fr', 'Grok', 'Connectez-vous à Grok avec `grok login` sur l’ordinateur qui exécute ce chat.'],
    [
      'fr',
      'Pi',
      'Connectez-vous à Pi en exécutant `pi` puis en utilisant `/login` sur l’ordinateur qui exécute ce chat.'
    ],
    ['fr', 'OMP', 'Connectez-vous à OMP.'],
    [
      'ja',
      'Grok',
      'このチャットを実行しているコンピューターで `grok login` を使って Grok にサインインしてください。'
    ],
    [
      'ja',
      'Pi',
      'このチャットを実行しているコンピューターで `pi` を起動し、`/login` を使って Pi にサインインしてください。'
    ],
    ['ja', 'OMP', 'OMP にサインインしてください。']
  ])(
    'rewords known %s auth facts for %s and keeps literal diagnostics',
    async (locale, agentName, guidance) => {
      await i18n.changeLanguage(locale)
      const detail = 'Provider diagnostic: {{agent}} must remain literal.'
      const words = agentSessionFailureWords(
        { kind: 'notSignedIn', detail: { text: detail, audience: 'person' } },
        { agentName, surface: 'row' }
      )
      renderStatus(
        {
          kind: 'status',
          ...words,
          tone: 'error'
        },
        null,
        false,
        false,
        agentName
      )
      expect(
        screen.getByText(`${guidance}${locale === 'ja' ? '' : ' '}${detail}`)
      ).toBeInTheDocument()
      expect(screen.queryByText(words.text)).toBeNull()
    }
  )

  it('rewords managed-account facts without leaking system login instructions', async () => {
    await i18n.changeLanguage('fr')
    renderStatus(
      {
        kind: 'status',
        tone: 'error',
        ...agentSessionFailureWords(
          { kind: 'notSignedIn', account: 'managed' },
          { agentName: 'Claude', surface: 'row' }
        )
      },
      null,
      false,
      false,
      'Claude'
    )
    expect(
      screen.getByText(
        'Ce compte Claude n’est pas connecté. Reconnectez-vous dans les paramètres des Comptes Claude.'
      )
    ).toBeInTheDocument()
    expect(screen.queryByText(/claude auth login/)).toBeNull()
  })

  it.each([{ kind: 'futureFailure' }, { kind: 'notSignedIn', account: 'futureAccount' }])(
    'keeps the host fallback for facts this client cannot fully understand (%j)',
    async (failure) => {
      await i18n.changeLanguage('ja')
      const newerRow = {
        kind: 'status',
        tone: 'error',
        text: 'Future host guidance',
        failure
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: simulates an older client receiving a newer host's unknown failure fact.
      const row = newerRow as unknown as AgentJournalStatusItem
      renderStatus(row, null, false, false, 'Grok')
      expect(screen.getByText('Future host guidance')).toBeInTheDocument()
    }
  )
  it("shows the host's words for a background task the agent would not stop, as an older client does", async () => {
    await i18n.changeLanguage('ja')
    // A client that predates the kind reads no fact, so the row's own text is what it shows.
    renderStatus(
      {
        kind: 'status',
        ...agentSessionFailureWords(
          agentSessionFailureFact('backgroundTaskNotStopped', { backgroundStop: 'task' }),
          { surface: 'row' }
        )
      },
      null,
      false,
      false,
      'Codex'
    )
    expect(screen.getByText("The background task wasn't stopped.")).toBeInTheDocument()
  })
  it('renders compaction as a centered separator', () => {
    renderStatus({ kind: 'status', text: 'Context compacted', presentation: 'compaction' })
    expect(screen.getByRole('separator', { name: 'Context compacted' })).toHaveClass(
      'text-chat-foreground-faint'
    )
    expect(
      screen.getByText('Context compacted').parentElement?.querySelectorAll('.bg-border')
    ).toHaveLength(2)
  })
  it('renders a plan as readable markdown in the card primitive', () => {
    renderStatus({
      kind: 'status',
      text: '# Steps\n\nA **readable** document.',
      presentation: 'plan-document'
    })
    expect(screen.getByText('Plan').closest('[data-slot="card"]')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Steps' })).toBeInTheDocument()
    expect(screen.getByText('readable').tagName).toBe('STRONG')
    expect(screen.getByText('readable').closest('[data-slot="card-content"]')).toHaveClass(
      'text-sm',
      'text-foreground'
    )
  })
  it('shows provider notice text once while retaining its diagnostic disclosure', () => {
    renderStatus({
      kind: 'status',
      text: 'Check the configuration',
      tone: 'warning',
      providerFrame: {
        provider: 'codex',
        kind: 'notification:warning',
        payload: {
          head: '{"message":"Check the configuration"}',
          byteLength: 37,
          digest: 'digest',
          truncated: false
        }
      }
    })
    expect(screen.getAllByText('Check the configuration')).toHaveLength(1)
    const disclosure = screen.getByText('Details').closest('details')
    expect(disclosure?.querySelector('summary')).not.toHaveTextContent('Check the configuration')
    expect(disclosure?.querySelector('pre')).toHaveTextContent('Check the configuration')
  })
  it('retains person-facing usage details without inventing a provider frame', () => {
    renderStatus({
      kind: 'status',
      tone: 'warning',
      ...agentSessionFailureWords(
        agentSessionFailureFact('usageLimitReached', {
          detail: { audience: 'person', text: 'Your allowance resets tomorrow.' }
        }),
        { surface: 'row' }
      )
    })
    const disclosure = screen.getByText('Details').closest('details')
    expect(disclosure?.querySelector('pre')).toHaveTextContent('Your allowance resets tomorrow.')
    expect(screen.queryByText('codex')).not.toBeInTheDocument()
  })
  it('keeps the column layout of command output in monospace', () => {
    const text =
      'Context Usage\n⛁ ⛁ ⛶   gpt-4o · 16.6k/128k tokens (13%)\n      ⛁ Skills: 304 tokens'
    render(
      <MessageRow
        message={{
          id: 'command-output',
          role: 'system',
          blocks: [{ type: 'text', text, presentation: 'command-output' }],
          timestamp: 1,
          source: 'transcript'
        }}
        expandSignal={false}
        onScrollMessageToTop={vi.fn()}
      />
    )
    const output = screen.getByText(/Context Usage/)
    expect(output.tagName).toBe('PRE')
    expect(output).toHaveClass('font-mono')
    expect(output.textContent).toBe(text)
  })
  // The host's text is only for a client that can't word the row itself.
  it.each([
    ['history-repaired', "Part of this chat's history couldn't be loaded."],
    ['history-item-too-large', 'This part of the chat was too large to show.']
  ])('words a %s row itself, as a muted status line', (presentation, words) => {
    renderStatus({ kind: 'status', text: 'Words an older host wrote', presentation })
    expect(screen.getByText(words)).toHaveClass('text-chat-foreground-faint', 'text-sm')
    expect(screen.queryByText('Words an older host wrote')).toBeNull()
  })
})

describe('Codex installation in notice rows', () => {
  it.each([null, '0.135.0'])(
    'shows the plain host failure through the ordinary notice row: %s',
    (installedVersion) => {
      const failure: AgentSessionFailureFact = {
        kind: installedVersion === null ? 'cliMissing' : 'startFailed',
        ...(installedVersion === null
          ? {}
          : {
              refusal: {
                code: 'agent_session_operation_invalid',
                details: {
                  reason: 'attachFailed',
                  codexInstallation: { installedVersion, minimumVersion: '0.136.0' }
                }
              }
            })
      }
      const text = installedVersion
        ? 'Codex 0.135.0 is too old for chats. Update to 0.136.0 or newer.'
        : "Codex wasn't found on the computer running this chat. Install it, or check its Command in Settings → Agents."
      renderStatus(
        {
          kind: 'status',
          tone: 'error',
          ...agentSessionFailureWords(failure, { agentName: 'Codex', surface: 'row' })
        },
        null,
        false,
        false,
        'Codex'
      )
      expect(screen.getByText(text)).toBeInTheDocument()
      expect(screen.queryByRole('button')).toBeNull()
    }
  )
})

it('opens Antigravity accounts from its signed-out notice, and offers no link for other failures', () => {
  const original = useAppStore.getState()
  const openSettingsPage = vi.fn()
  const openSettingsTarget = vi.fn()
  useAppStore.setState({ openSettingsPage, openSettingsTarget })
  try {
    renderStatus(
      {
        kind: 'status',
        tone: 'error',
        ...agentSessionFailureWords(
          { kind: 'notSignedIn' },
          { agentName: 'Antigravity', surface: 'row' }
        )
      },
      null,
      false,
      false,
      'Antigravity'
    )
    const link = screen.getByRole('link', { name: 'Settings → Accounts → Antigravity' })
    expect(link.parentElement).toHaveTextContent(
      "Antigravity isn't signed in. Sign in under Settings → Accounts → Antigravity. Then send your message again."
    )
    expect(screen.queryByRole('button')).toBeNull()
    fireEvent.click(link)
    expect(openSettingsTarget).toHaveBeenCalledExactlyOnceWith({
      pane: 'accounts',
      repoId: null,
      sectionId: 'accounts-antigravity'
    })
    expect(openSettingsPage).toHaveBeenCalledOnce()
    cleanup()
    for (const [agentName, kind] of [
      ['Antigravity', 'startFailed'],
      ['Claude', 'notSignedIn']
    ] as const) {
      renderStatus(
        {
          kind: 'status',
          tone: 'error',
          ...agentSessionFailureWords({ kind }, { agentName, surface: 'row' })
        },
        null,
        false,
        false,
        agentName
      )
      expect(screen.queryByRole('link')).toBeNull()
      cleanup()
    }
  } finally {
    useAppStore.setState({
      openSettingsPage: original.openSettingsPage,
      openSettingsTarget: original.openSettingsTarget
    })
  }
})

it('renders the localized unacknowledged goal pause through the existing Stop notice', async () => {
  await i18n.changeLanguage('ja')
  renderStatus({
    kind: 'status',
    tone: 'warning',
    ...agentSessionFailureWords(agentSessionFailureFact('cancelUnconfirmed'), {
      surface: 'row',
      stopNotice: 'pauseUnconfirmed'
    })
  })
  expect(
    screen.getByText(
      'Codex の実行は停止しましたが、目標の一時停止は確認されていません。続行する前に目標を確認してください。'
    )
  ).toBeInTheDocument()
})

// Protocol-shaped synthetic notices; no exact recorded review/denial capture is available.
it.each([
  [
    'codex',
    'notification:guardianWarning',
    'warning',
    'Codex reported a safety review warning. View details.',
    'Codex a signalé un avertissement de sécurité. Voir les détails.'
  ],
  [
    'claude',
    'message:system:permission_denied',
    'error',
    'Claude denied permission. View details.',
    'Claude a refusé la permission. Voir les détails.'
  ]
] as const)(
  'compacts the declared %s notice while retaining every available diagnostic',
  async (provider, kind, tone, heading, french) => {
    const text = `${'安全 '.repeat(1500)}EXPLANATION_SENTINEL`
    const head = `{"partial":"${'é'.repeat(4500)}PAYLOAD_SENTINEL`
    renderStatus({
      kind: 'status',
      tone,
      text,
      providerFrame: {
        provider,
        kind,
        payload: { head, byteLength: 99999, digest: 'synthetic', truncated: true }
      }
    })
    const summary = screen.getByText(heading).closest('summary')!
    const disclosure = summary.closest('details')!
    expect(disclosure.open).toBe(false)
    expect(summary).not.toHaveTextContent(/SENTINEL|99999/)
    expect(disclosure.parentElement).not.toHaveClass('text-destructive', 'text-chat-warning')
    fireEvent.click(summary)
    expect(disclosure.open).toBe(true)
    const detail = disclosure.querySelector('pre')!
    expect(detail.textContent).toContain(text)
    expect(detail.textContent).toContain(head)
    expect(detail).toHaveTextContent('Provider response truncated (original size: 99999 bytes).')
    expect(detail).toHaveClass(tone === 'error' ? 'text-destructive' : 'text-chat-warning')
    expect(screen.queryByText('Show full output')).toBeNull()
    await act(() => i18n.changeLanguage('fr'))
    expect(summary).toHaveTextContent(french)
    expect(detail).toHaveTextContent(
      'Réponse du fournisseur tronquée (taille d’origine : 99999 octets).'
    )
    expect(disclosure.open).toBe(true)
  }
)
