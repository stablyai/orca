// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { render } from './native-chat-tooltip-test-harness'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Profiler } from 'react'
import { NativeChatSettledBodyContext } from './native-chat-settled-body'
import { createAgentSessionSettledBodyReader } from '../../../../shared/agent-session-settled-body-reader'
import { agentSessionJsonPiece } from '../../../../shared/agent-session-json-pieces'
import {
  AGENT_SESSION_SETTLED_BODY_CAPABILITY,
  type AgentSessionSettledBodyRead
} from '../../../../shared/agent-session-settled-body'
import { i18n } from '@/i18n/i18n'
import type {
  AgentJournalQuestionItem,
  AgentJournalRenderItem
} from '../../../../shared/agent-session-journal-types'
import { encodeAgentSessionQuestionAnswers } from '../../../../shared/agent-session-question-answer'
import { NativeChatResolutionReceipt } from './NativeChatResolutionReceipt'
import { structuredQuestionTranscript } from '../../../../shared/structured-agent-question-projection'
import {
  NativeChatDisclosureContext,
  useNativeChatDisclosures
} from './native-chat-disclosure-store'
import {
  nativeChatReceiptAnswers,
  type NativeChatResolvedPrompt
} from '../../../../shared/native-chat-resolution-receipt'

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
})
const approval: NativeChatResolvedPrompt = {
  kind: 'approval',
  title: 'Run command?',
  detail: 'pnpm test',
  options: [
    { id: 'yes', label: 'Allow once' },
    { id: 'no', label: 'Deny' }
  ],
  resolution: {
    state: 'resolved',
    selectedOptionId: 'yes',
    resolvedBy: 'phone-client',
    resolvedAt: 1000
  }
}

describe('resolution receipts', () => {
  it.each([2, 20])(
    'shares exact bodies at N/10N across %s host owners without unrelated consumer commits',
    async (count) => {
      const exact: NativeChatResolvedPrompt = {
        ...approval,
        title: 'Exact saved form',
        detail: null,
        form: {
          fields: [
            { name: 'answer', required: true, schema: { type: 'string' } },
            {
              name: 'color',
              required: true,
              schema: {
                type: 'string',
                enum: ['a'.repeat(4000) + 'r'.repeat(4000), 'a'.repeat(4000) + 'b'.repeat(4000)],
                enumNames: ['Red label', 'Blue label']
              }
            }
          ]
        },
        resolution: {
          ...approval.resolution,
          selectedOptionId: null,
          formContent: {
            answer: `  first\n${'x'.repeat(60000)}\nlast  `,
            color: 'a'.repeat(4000) + 'b'.repeat(4000)
          }
        }
      }
      const descriptor = {
        contract: AGENT_SESSION_SETTLED_BODY_CAPABILITY,
        version: 'approval-json.v1' as const,
        state: 'resolved' as const
      }
      const hosts = Array.from({ length: count }, (_, index) => {
        const source = {
          ...descriptor,
          sessionId: `host-${index}`,
          epoch: `epoch-${index}`,
          itemId: 'item-1',
          revision: 2
        }
        let finish!: () => void
        const gate = new Promise<void>((resolve) => {
          finish = resolve
        })
        const read = vi.fn(async (request: AgentSessionSettledBodyRead) => {
          await gate
          return { source, ...agentSessionJsonPiece(JSON.stringify(exact), request.cursor) }
        })
        const reader = createAgentSessionSettledBodyReader(read)
        return {
          source,
          reader,
          read,
          finish,
          commits: vi.fn(),
          owner: Object.freeze({ reader, sessionId: source.sessionId, epoch: source.epoch })
        }
      })
      const view = render(
        <>
          {hosts.map((host, index) => (
            <NativeChatSettledBodyContext.Provider key={index} value={host.owner}>
              <Profiler id={`host-${index}`} onRender={host.commits}>
                {[0, 1].map((duplicate) => (
                  <NativeChatResolutionReceipt
                    key={duplicate}
                    body={{
                      ...approval,
                      title: 'Saved form',
                      options: [],
                      resolution: { ...approval.resolution, selectedOptionId: null },
                      deferredBody: {
                        itemId: host.source.itemId,
                        revision: host.source.revision,
                        descriptor
                      }
                    }}
                  />
                ))}
              </Profiler>
            </NativeChatSettledBodyContext.Provider>
          ))}
        </>
      )
      try {
        await act(async () => {
          await Promise.resolve()
        })
        for (const [index, host] of hosts.entries()) {
          const before = hosts.map((held) => held.commits.mock.calls.length)
          // One actual addressed completion per act; no batching hides fan-out.
          await act(async () => {
            host.finish()
            await vi.waitFor(() =>
              expect(host.reader.getSnapshot(host.source).status).toBe('ready')
            )
          })
          expect(host.read).toHaveBeenCalledTimes(Math.ceil(JSON.stringify(exact).length / 24576))
          expect(host.commits.mock.calls.length).toBeGreaterThan(before[index])
          hosts.forEach((other, otherIndex) => {
            if (other !== host) {
              expect(other.commits).toHaveBeenCalledTimes(before[otherIndex])
            }
          })
          await act(async () => {
            hosts.forEach((held) => held.reader.retry())
            await Promise.resolve()
          })
          hosts.forEach((other, otherIndex) => {
            if (other !== host) {
              expect(other.commits).toHaveBeenCalledTimes(before[otherIndex])
            }
          })
        }
        expect(screen.getAllByText('Blue label')).toHaveLength(count * 2)
        expect(screen.queryByText('Red label')).toBeNull()
        const answers = view.container.querySelectorAll(
          '[data-native-chat-receipt="approval"] p.whitespace-pre-wrap'
        )
        const fullAnswers = Array.from(answers).filter(
          (answer) => answer.textContent === exact.resolution.formContent!.answer
        )
        expect(fullAnswers).toHaveLength(count * 2)
        fullAnswers.forEach((answer) => expect(answer).not.toHaveClass('line-clamp-3'))
      } finally {
        view.unmount()
        hosts.forEach((host) => host.reader.dispose())
      }
    }
  )

  it('projects saved whole-form values into the existing receipt without filling omitted fields', () => {
    const body: NativeChatResolvedPrompt = {
      ...approval,
      title: 'Configure report',
      detail: null,
      form: {
        fields: [
          { name: 'name', required: true, schema: { type: 'string', title: 'Name' } },
          { name: 'count', required: true, schema: { type: 'integer' } },
          { name: 'confirmed', required: true, schema: { type: 'boolean' } },
          {
            name: 'color',
            required: true,
            schema: {
              type: 'string',
              enum: ['blue', 'red'],
              enumNames: ['Blue label', 'Red label']
            }
          },
          { name: 'space', required: true, schema: { type: 'string' } },
          { name: 'empty', required: false, schema: { type: 'string' } },
          {
            name: 'omitted',
            required: false,
            schema: { type: 'string', default: 'Do not restore' }
          }
        ]
      },
      resolution: {
        ...approval.resolution,
        selectedOptionId: null,
        formContent: {
          name: 'Ada',
          count: 0,
          confirmed: false,
          color: 'red',
          space: '  ',
          empty: ''
        }
      }
    }
    const receipt = structuredQuestionTranscript([
      { itemId: 'saved-form', revision: 2, sequence: 1, observedAt: 1000, body }
    ]).receipts.get('saved-form')!
    expect(receipt).toBe(body)
    render(<NativeChatResolutionReceipt body={receipt} />)
    expect(nativeChatReceiptAnswers(receipt)).toEqual([
      { question: 'Name', answer: 'Ada' },
      { question: 'count', answer: '0' },
      { question: 'confirmed', answer: 'No' },
      { question: 'color', answer: 'Red label' },
      { question: 'space', answer: '  ' },
      { question: 'empty', answer: '' }
    ])
    for (const text of [
      'Configure report',
      'Name',
      'Ada',
      '0',
      'No',
      'Red label',
      'Empty answer'
    ]) {
      expect(screen.getByText(text)).toBeInTheDocument()
    }
    expect(screen.getByText('space').nextElementSibling?.textContent).toBe('  ')
    expect(screen.queryByText('omitted')).toBeNull()
    expect(screen.queryByText('Selected answer unavailable')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('localizes the resolved time when the UI language changes', async () => {
    render(<NativeChatResolutionReceipt body={approval} />)
    await act(async () => {
      await i18n.changeLanguage('fr')
    })
    expect(screen.getByRole('time')).toHaveTextContent(
      new Intl.DateTimeFormat('fr', { hour: 'numeric', minute: '2-digit' }).format(1000)
    )
    expect(screen.getByRole('time')).toHaveAccessibleName(
      new Intl.DateTimeFormat('fr', { dateStyle: 'full', timeStyle: 'long' }).format(1000)
    )
  })

  it.each([
    ['yes', 'Allow once'],
    ['no', 'Deny']
  ])('shows the exact selected approval label for %s', (id, label) => {
    render(
      <NativeChatResolutionReceipt
        body={{ ...approval, resolution: { ...approval.resolution, selectedOptionId: id } }}
      />
    )
    expect(screen.getByText('Run command?')).toBeInTheDocument()
    expect(screen.getByText('pnpm test')).toBeInTheDocument()
    expect(screen.getByText(label)).toBeInTheDocument()
    expect(screen.getByText('Answered on phone-client')).toBeInTheDocument()
    expect(document.querySelector('time')).toHaveAttribute('datetime', new Date(1000).toISOString())
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('uses the SDK display name in the compact resolved receipt', () => {
    render(
      <NativeChatResolutionReceipt
        body={{
          ...approval,
          title: 'Claude wants to present its implementation plan',
          displayName: 'Present plan'
        }}
      />
    )

    expect(screen.getByText('Present plan')).toBeInTheDocument()
    expect(screen.queryByText('Claude wants to present its implementation plan')).toBeNull()
  })

  it('renders cancellation quietly without inventing a choice or resolver', () => {
    render(
      <NativeChatResolutionReceipt
        body={{
          ...approval,
          resolution: {
            state: 'cancelled',
            selectedOptionId: null,
            resolvedBy: null,
            resolvedAt: null
          }
        }}
      />
    )
    expect(screen.getByText('Cancelled')).toBeInTheDocument()
    expect(screen.queryByText('Allow once')).toBeNull()
    expect(screen.queryByText('Selected answer unavailable')).toBeNull()
    expect(document.querySelector('time')).toBeNull()
  })

  it.each([null, 'unknown'])('handles absent or unknown selections (%s)', (selectedOptionId) => {
    render(
      <NativeChatResolutionReceipt
        body={{ ...approval, resolution: { ...approval.resolution, selectedOptionId } }}
      />
    )
    expect(screen.getByText('Selected answer unavailable')).toBeInTheDocument()
    expect(screen.queryByText('Allow once')).toBeNull()
  })

  it('excludes pending prompts', () => {
    const { container } = render(
      <NativeChatResolutionReceipt
        body={{ ...approval, resolution: { ...approval.resolution, state: 'pending' } }}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('reads grouped options from each question despite an empty flat options list', () => {
    const body: AgentJournalQuestionItem = {
      kind: 'question',
      question: 'Choose settings',
      options: [],
      questions: [
        {
          id: 'q1',
          question: 'Features?',
          multiSelect: true,
          options: [
            { id: 'a', label: 'First' },
            { id: 'b', label: 'Second' }
          ]
        },
        { id: 'q2', question: 'Name?', multiSelect: false, options: [], freeTextQuestionId: 'q2' }
      ],
      resolution: {
        ...approval.resolution,
        selectedOptionId: encodeAgentSessionQuestionAnswers([
          { questionId: 'q1', optionIds: ['a', 'b'] },
          { questionId: 'q2', optionIds: [], other: 'Custom 100% name' }
        ])
      }
    }
    render(<NativeChatResolutionReceipt body={body} />)
    expect(screen.getByText('Features?')).toBeInTheDocument()
    expect(screen.getByText('First · Second')).toBeInTheDocument()
    expect(screen.getByText('Custom 100% name')).toBeInTheDocument()
    expect(screen.queryByText('Selected answer unavailable')).toBeNull()
    expect(
      nativeChatReceiptAnswers({
        ...body,
        resolution: { ...body.resolution, selectedOptionId: 'question-group:invalid' }
      })
    ).toEqual([
      { question: 'Features?', answer: null },
      { question: 'Name?', answer: null }
    ])
  })

  it('keeps a single grouped question heading distinct from its answer line', () => {
    const body: AgentJournalQuestionItem = {
      kind: 'question',
      question: '1 grouped question from Claude',
      options: [],
      questions: [{ id: 'q1', question: 'Libraries?', multiSelect: true, options: [] }],
      resolution: {
        ...approval.resolution,
        selectedOptionId: encodeAgentSessionQuestionAnswers([
          { questionId: 'q1', optionIds: [], other: 'TypeScript' }
        ])
      }
    }

    render(<NativeChatResolutionReceipt body={body} />)
    expect(screen.getByText('1 grouped question from Claude')).toBeInTheDocument()
    expect(screen.getAllByText('Libraries?')).toHaveLength(1)
    expect(screen.getByText('TypeScript')).toBeInTheDocument()
  })

  it('does not repeat a single question above its answer', () => {
    const body: AgentJournalQuestionItem = {
      kind: 'question',
      question: 'Libraries?',
      options: [],
      questions: [{ id: 'q1', question: 'Libraries?', multiSelect: false, options: [] }],
      resolution: {
        ...approval.resolution,
        selectedOptionId: encodeAgentSessionQuestionAnswers([
          { questionId: 'q1', optionIds: [], other: 'TypeScript' }
        ])
      }
    }

    render(<NativeChatResolutionReceipt body={body} />)
    expect(screen.getAllByText('Libraries?')).toHaveLength(1)
    expect(screen.getByText('TypeScript')).toBeInTheDocument()
  })

  it('names the actual question while a single grouped prompt is pending', () => {
    const body: AgentJournalQuestionItem = {
      kind: 'question',
      question: '1 grouped question from Claude',
      options: [],
      questions: [{ id: 'q1', question: 'Libraries?', multiSelect: true, options: [] }],
      resolution: { ...approval.resolution, state: 'pending', selectedOptionId: null }
    }

    render(<NativeChatResolutionReceipt body={body} />)
    expect(screen.getByText('Libraries?')).toBeInTheDocument()
    expect(screen.queryByText('1 grouped question from Claude')).toBeNull()
  })

  it('reports, without breathing, a question whose agent ended (the host says nobody waits)', () => {
    const body: AgentJournalQuestionItem = {
      kind: 'question',
      question: 'Which branch?',
      options: [],
      resolution: { ...approval.resolution, state: 'pending', selectedOptionId: null }
    }

    const { rerender } = render(<NativeChatResolutionReceipt body={body} />)
    expect(screen.getByText('Awaiting user input:')).toHaveClass('animate-pulse')
    rerender(<NativeChatResolutionReceipt body={body} awaiting={false} />)
    expect(screen.queryByText('Awaiting user input:')).toBeNull()
    expect(screen.getByText('Asked:')).not.toHaveClass('animate-pulse')
    expect(screen.getByText('Which branch?')).toBeInTheDocument()
  })

  it('keeps an opened question open once it is answered', () => {
    const scrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth')
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      get: () => 400
    })
    const pendingBody: AgentJournalQuestionItem = {
      kind: 'question',
      question: 'Which of the three migration strategies should I use?',
      options: [{ id: 'a', label: 'Strategy A' }],
      resolution: { ...approval.resolution, state: 'pending', selectedOptionId: null }
    }
    function Harness({ body }: { body: AgentJournalQuestionItem }): React.JSX.Element {
      const disclosures = useNativeChatDisclosures()
      return (
        <NativeChatDisclosureContext.Provider value={disclosures}>
          <NativeChatResolutionReceipt body={body} disclosureId="message-1" />
        </NativeChatDisclosureContext.Provider>
      )
    }
    try {
      const { rerender } = render(<Harness body={pendingBody} />)
      fireEvent.click(screen.getByRole('button', { name: /Awaiting user input:/ }))

      rerender(
        <Harness
          body={{ ...pendingBody, resolution: { ...approval.resolution, selectedOptionId: 'a' } }}
        />
      )
      expect(screen.getByRole('button', { name: /Asked:/ })).toHaveAttribute(
        'aria-expanded',
        'true'
      )
    } finally {
      if (scrollWidth) {
        Object.defineProperty(HTMLElement.prototype, 'scrollWidth', scrollWidth)
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollWidth')
      }
    }
  })

  describe('a grouped question', () => {
    const FIRST = 'Which of the three migration strategies should I use for the orders table?'
    const SECOND = 'Should the old columns be dropped in the same release?'
    const grouped: AgentJournalQuestionItem = {
      kind: 'question',
      question: '2 grouped questions from Claude',
      options: [],
      questions: [
        { id: 'q1', question: FIRST, multiSelect: false, options: [{ id: 'a', label: 'A' }] },
        { id: 'q2', question: SECOND, multiSelect: false, options: [{ id: 'y', label: 'Yes' }] }
      ],
      resolution: { state: 'cancelled', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    }

    function Harness({
      body,
      mounted = true
    }: {
      body: AgentJournalQuestionItem
      mounted?: boolean
    }): React.JSX.Element {
      const disclosures = useNativeChatDisclosures()
      return (
        <NativeChatDisclosureContext.Provider value={disclosures}>
          {mounted ? <NativeChatResolutionReceipt body={body} disclosureId="message-1" /> : null}
        </NativeChatDisclosureContext.Provider>
      )
    }

    it('lists every question of a cancelled prompt below its toggle', () => {
      const { rerender } = render(<Harness body={grouped} />)
      const toggle = screen.getByRole('button', { name: /Asked:\s*2 questions/ })
      expect(toggle).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByText(FIRST)).toBeNull()

      fireEvent.click(toggle)
      expect(toggle).toHaveAttribute('aria-expanded', 'true')
      expect(toggle).toHaveTextContent('2 questions')
      const items = screen.getAllByRole('listitem')
      expect(items.map((item) => item.textContent)).toEqual([FIRST, SECOND])
      expect(items[0]?.closest('button')).toBeNull()
      fireEvent.click(items[0]!)
      expect(toggle).toHaveAttribute('aria-expanded', 'true')

      rerender(<Harness body={grouped} mounted={false} />)
      rerender(<Harness body={grouped} />)
      const remounted = screen.getByRole('button', { name: /Asked:/ })
      expect(remounted).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByText(SECOND)).toBeInTheDocument()

      // Folding keeps the same control, so keyboard focus is not dropped.
      remounted.focus()
      fireEvent.click(remounted)
      expect(document.activeElement).toBe(remounted)
      expect(remounted).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByRole('list')).toBeNull()
    })

    it('lists the questions of a pending group the card may not be showing', () => {
      render(
        <Harness body={{ ...grouped, resolution: { ...grouped.resolution, state: 'pending' } }} />
      )
      fireEvent.click(screen.getByRole('button', { name: /Awaiting user input:\s*2 questions/ }))
      expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
        FIRST,
        SECOND
      ])
    })

    it('does not carry an opened Codex group onto its first question once answered', () => {
      const codexQuestion = (
        itemId: string,
        question: string,
        resolution: AgentJournalQuestionItem['resolution'] = {
          state: 'pending',
          selectedOptionId: null,
          resolvedBy: null,
          resolvedAt: null
        }
      ): AgentJournalRenderItem => ({
        itemId,
        sequence: 1,
        revision: 1,
        observedAt: 1,
        body: {
          kind: 'question',
          question,
          options: [{ id: `${itemId}-a`, label: 'A' }],
          resolution
        }
      })
      const receiptFor = (items: AgentJournalRenderItem[]): AgentJournalQuestionItem => {
        const body = structuredQuestionTranscript(items).receipts.get('message-1')
        if (body?.kind !== 'question') {
          throw new Error('expected a question receipt')
        }
        return body
      }
      const second = codexQuestion('message-2', SECOND)
      const { rerender } = render(
        <Harness body={receiptFor([codexQuestion('message-1', 'Branch?'), second])} />
      )
      fireEvent.click(screen.getByRole('button', { name: /Awaiting user input:\s*2 questions/ }))
      expect(screen.getByText('Branch?')).toBeInTheDocument()

      // Answering the first question gives it its own row under the group's id.
      const answered = codexQuestion('message-1', 'Branch?', {
        state: 'resolved',
        selectedOptionId: 'message-1-a',
        resolvedBy: null,
        resolvedAt: 1000
      })
      rerender(<Harness body={receiptFor([answered, second])} />)
      expect(screen.getByText('Branch?')).toHaveClass('truncate')
      expect(screen.queryByRole('button')).toBeNull()
    })

    it('stays plain once answered, since each question is listed with its answer', () => {
      render(
        <Harness
          body={{
            ...grouped,
            resolution: {
              state: 'resolved',
              selectedOptionId: null,
              answers: [
                { questionId: 'q1', optionIds: ['a'] },
                { questionId: 'q2', optionIds: ['y'] }
              ],
              resolvedBy: null,
              resolvedAt: 1000
            }
          }}
        />
      )
      expect(screen.getByText('2 questions')).toBeInTheDocument()
      expect(screen.queryByRole('button')).toBeNull()
      expect(screen.getAllByText(FIRST)).toHaveLength(1)
      expect(screen.getAllByText(SECOND)).toHaveLength(1)
      expect(screen.getByText('Yes')).toBeInTheDocument()
    })

    it('leaves a cancelled single question that fits its line as plain text', () => {
      render(
        <Harness
          body={{ ...grouped, question: FIRST, questions: grouped.questions?.slice(0, 1) }}
        />
      )
      expect(screen.getByText(FIRST)).toHaveClass('truncate')
      expect(screen.queryByRole('button')).toBeNull()
      expect(screen.queryByRole('list')).toBeNull()
    })
  })

  it('decodes single free-text answers only for the declared question', () => {
    const body: AgentJournalQuestionItem = {
      kind: 'question',
      question: 'Name?',
      options: [],
      freeTextQuestionId: 'name/id',
      resolution: { ...approval.resolution, selectedOptionId: 'name%2Fid:hello%20world' }
    }
    expect(nativeChatReceiptAnswers(body)).toEqual([{ question: null, answer: 'hello world' }])
    for (const selectedOptionId of ['other:hello', 'name%2Fid:%invalid']) {
      expect(
        nativeChatReceiptAnswers({ ...body, resolution: { ...body.resolution, selectedOptionId } })
      ).toEqual([{ question: null, answer: null }])
    }
  })

  it('reads the recorded structured answers before the packed form', () => {
    const typed = 'Wait for the capture to finish. '.repeat(50).trim()
    const body: AgentJournalQuestionItem = {
      kind: 'question',
      question: 'Name?',
      options: [{ id: 'q1:choice-1', label: 'Default' }],
      freeTextQuestionId: 'q1',
      resolution: {
        ...approval.resolution,
        // The packed copy only older clients read; it must not win over the recorded answer.
        selectedOptionId: 'q1:choice-1',
        answers: [{ questionId: 'q1', optionIds: [], other: typed }]
      }
    }

    expect(nativeChatReceiptAnswers(body)).toEqual([{ question: null, answer: typed }])
  })
})
