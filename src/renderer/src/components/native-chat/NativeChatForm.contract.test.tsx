// @vitest-environment happy-dom
import { NativeChatForm } from './NativeChatForm'
import { NativeChatResolutionReceipt } from './NativeChatResolutionReceipt'
import { i18n, loadRendererUiLanguage } from '@/i18n/i18n'
import type { AgentSessionForm } from '../../../../shared/agent-session-form'
import recordedFrames from '../../../../main/codex/__fixtures__/codex-app-server-mcp-elicitations.json'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { NativeChatApprovalCard } from './NativeChatApprovalCard'
import { respondToStructuredAgentSessionPrompt } from './structured-agent-session-prompt-response'
import { chatApprovalFromJournal } from '../../../../shared/native-chat-interactive-prompt'
import { RespondParams } from '../../../../shared/rpc-contract/structured-agent-session-params'
import {
  acquireReadyCodexForTest,
  adapterFor,
  fakeCodex,
  identityFor
} from '../../../../main/codex/codex-structured-session-adapter-fixture'
import {
  attach,
  CALLER,
  envelope,
  hostTestState
} from '../../../../main/native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from '../../../../main/native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { projectStructuredPermission } from '../../../../../mobile/src/session/mobile-structured-agent-prompts'
import { createAgentSessionCurrentRequestsReader } from '../../../../shared/agent-session-current-requests-reader'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'

const frames = z
  .array(
    z.object({
      id: z.union([z.string(), z.number()]),
      method: z.string(),
      params: z.record(z.string(), z.unknown())
    })
  )
  .parse(recordedFrames)
const recorded = frames.find((frame) => frame.params.mode === 'form')!
const schema = z
  .object({ properties: z.record(z.string(), z.record(z.string(), z.unknown())) })
  .parse(recorded.params.requestedSchema)
type RecordedFormDefaults = Partial<Record<string, string | number | boolean>>
const defaults: RecordedFormDefaults = {
  color: 'blue',
  confirmed: false,
  count: 0,
  name: '  ',
  note: ''
}
let adapter: ReturnType<typeof adapterFor>
beforeEach(() => {
  adapter = adapterFor(fakeCodex())
})
afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
  await adapter.closeAll()
})

async function formSession(properties?: Record<string, Record<string, unknown>>) {
  const state = hostTestState()
  await attach()
  const codex = fakeCodex()
  adapter = adapterFor(codex, { resumeThreadId: THREAD })
  const fence = state.store.getRecord(SESSION)!.lease.runtimeFence
  await acquireReadyCodexForTest(adapter, {
    identity: identityFor(SESSION),
    fence,
    spawnToken: 'spawn-a',
    events: state.acquire.mock.calls.at(-1)![0].events
  })
  state.answerPrompt.mockImplementation((input) => adapter.answerPrompt(input))
  const request = {
    ...recorded,
    params: {
      ...recorded.params,
      threadId: THREAD,
      turnId: 'turn-1',
      requestedSchema: {
        ...schema,
        type: 'object',
        required: properties ? Object.keys(properties) : ['color', 'confirmed', 'count', 'name'],
        properties:
          properties ??
          Object.fromEntries(
            Object.entries(schema.properties).map(([name, field]) => [
              name,
              { ...field, default: defaults[name] }
            ])
          )
      }
    }
  }
  codex.connections[0].handlers.onServerRequest?.(request)
  await state.host.flushStreamedEvents(SESSION)
  const marker = state.host.currentWork(SESSION)!.requestProjection(SESSION).marker
  let pieces = 0
  const items = await new Promise<AgentJournalRenderItem[]>((resolve, reject) => {
    const reader = createAgentSessionCurrentRequestsReader({
      read: (request) => {
        pieces++
        return state.host.readCurrentRequests(request)
      },
      complete: (_marker, items) => {
        reader.invalidate()
        resolve(items)
      },
      replaceMarker: () => {},
      error: reject
    })
    reader.observe(marker)
  })
  const item = items.find((item) => item.body.kind === 'approval')
  if (!item || item.body.kind !== 'approval') {
    throw new Error('Missing form')
  }
  const prompt = { ...item, body: item.body }
  expect(projectStructuredPermission(prompt)?.form).toEqual(prompt.body.form)
  expect(chatApprovalFromJournal(prompt.body).form).toEqual(prompt.body.form)
  const mutate = vi.fn()
  mutate.mockImplementation(async (_method, fingerprintMethod, fields) => {
    const params = RespondParams.parse({ ...fields, envelope: envelope(fingerprintMethod, fields) })
    const result = await state.host.respondToPrompt(CALLER, { ...params, kind: 'approval' })
    expect(result.ok).toBe(true)
    return result.ok ? result.value : null
  })
  const action = { target: { kind: 'local' as const }, mutate, write: vi.fn() }
  render(
    <NativeChatApprovalCard
      approval={chatApprovalFromJournal(prompt.body)}
      onChoose={(optionId) => {
        void respondToStructuredAgentSessionPrompt({
          item: prompt,
          response: { kind: 'option', optionId },
          action
        })
      }}
      onSubmitForm={(content) => {
        void respondToStructuredAgentSessionPrompt({
          item: prompt,
          response: { kind: 'form', content },
          action
        })
      }}
    />
  )
  return { ...state, codex, request, prompt, mutate, pieces }
}

it.each([0, 64])(
  'keeps a %s-field recorded request complete through the operational reader, controls and provider result',
  async (count) => {
    const properties = Object.fromEntries(
      Array.from({ length: count }, (_, i) => [
        `f${i}`,
        i === 0
          ? { type: 'boolean', default: false }
          : i === 1
            ? { type: 'number', default: 0 }
            : i === 2
              ? { type: 'string', enum: ['', 'blue'], default: '' }
              : { type: 'string', default: i === 3 ? '  ' : i === 4 ? '' : 'x'.repeat(400) }
      ])
    )
    const h = await formSession(properties)
    expect(h.prompt.body.form?.fields).toHaveLength(count)
    if (count === 64) {
      expect(h.pieces).toBeGreaterThan(1)
    }
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    const content = Object.fromEntries(
      Object.entries(properties).map(([name, schema]) => [name, schema.default])
    )
    await waitFor(() =>
      expect(h.codex.connections[0].replies).toEqual([
        { id: 0, result: { action: 'accept', content, _meta: null } }
      ])
    )
    expect(h.answerPrompt).toHaveBeenCalledOnce()
  }
)

it('submits untouched recorded form defaults from rendered controls through host commit to the exact provider', async () => {
  const h = await formSession()
  expect(h.codex.connections[0].replies).toEqual([])
  expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('  ')
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
  await waitFor(() =>
    expect(h.codex.connections[0].replies).toEqual([
      { id: 0, result: { action: 'accept', content: defaults, _meta: null } }
    ])
  )
  expect(h.mutate).toHaveBeenCalledWith(
    'agentSession.respondToApproval',
    'agentSession.respondTo:approval',
    expect.objectContaining({ content: defaults })
  )
  const saved = h.host
    .collaboratorsForTests()
    .sessions.get(SESSION)!
    .journal.itemBody(h.prompt.itemId)
  expect(saved).toMatchObject({
    resolution: { state: 'resolved', formContent: defaults, selectedOptionId: null }
  })
})

it('keeps invalid edits local; selecting a choice replaces its default and Clear omits optional empty text', async () => {
  const h = await formSession()
  fireEvent.change(screen.getByLabelText('count'), { target: { value: '11' } })
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
  expect(screen.getByRole('alert').textContent).toContain('at most 10')
  expect(h.mutate).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('count'), { target: { value: '0' } })
  fireEvent.click(screen.getByRole('radio', { name: 'Yes' }))
  fireEvent.click(screen.getByRole('radio', { name: 'Red label' }))
  fireEvent.click(screen.getByRole('button', { name: 'Clear note' }))
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
  await waitFor(() =>
    expect(h.codex.connections[0].replies).toEqual([
      {
        id: 0,
        result: {
          action: 'accept',
          content: { color: 'red', confirmed: true, count: 0, name: '' },
          _meta: null
        }
      }
    ])
  )
  expect(h.answerPrompt).toHaveBeenCalledOnce()
})

it('re-derives pending errors, controls and saved Boolean labels on locale changes without changing draft or typed content', async () => {
  const form: AgentSessionForm = {
    fields: [
      {
        name: 'Name',
        required: true,
        schema: { type: 'string', minLength: 3, default: 'initial' }
      },
      { name: 'Boolean', required: true, schema: { type: 'boolean', default: false } },
      { name: 'Number', required: true, schema: { type: 'number', default: 0 } },
      { name: 'Enum', required: true, schema: { type: 'string', enum: ['Yes'], default: 'Yes' } },
      { name: 'Empty', required: true, schema: { type: 'string', default: '' } },
      { name: 'Omitted', required: false, schema: { type: 'string', default: '' } }
    ]
  }
  const submitted = vi.fn()
  const view = render(<NativeChatForm form={form} disabled={false} onSubmit={submitted} />)
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x' } })
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
  expect(screen.getByRole('alert').textContent).toBe('Enter at least 3 characters.')
  await loadRendererUiLanguage('fr')
  // Fixture translations prove new-key lookup/interpolation; target catalogs stay untouched.
  i18n.addResourceBundle(
    'fr',
    'translation',
    {
      components: {
        'native-chat': {
          form: {
            yes: 'Oui',
            no: 'Non',
            optional: 'Facultatif',
            clear: 'Effacer',
            clearField: 'Effacer {{field}}',
            error: { minLength: 'Au moins {{minimum}} caractères.' }
          }
        }
      }
    },
    true,
    true
  )
  try {
    await act(async () => {
      await i18n.changeLanguage('fr')
    })
    expect(screen.getByRole('button', { name: 'Valider' })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('Au moins 3 caractères.')
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('x')
    expect(screen.getByRole('radio', { name: 'Non' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('radio', { name: 'Yes' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Effacer Omitted' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  texte  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Valider' }))
    const content = { Boolean: false, Empty: '', Enum: 'Yes', Name: '  texte  ', Number: 0 }
    expect(submitted).toHaveBeenCalledExactlyOnceWith(content)
    view.unmount()
    render(
      <NativeChatResolutionReceipt
        body={{
          kind: 'approval',
          title: 'Provider title',
          detail: null,
          options: [],
          form,
          resolution: {
            state: 'resolved',
            selectedOptionId: null,
            resolvedBy: null,
            resolvedAt: null,
            formContent: content
          }
        }}
      />
    )
    expect(screen.getByText('Non')).toBeTruthy()
    expect(screen.getByText('Yes')).toBeTruthy()
    expect(screen.getByText('0')).toBeTruthy()
    expect(screen.getByText('texte').textContent).toBe('  texte  ')
    expect(screen.queryByText('Omitted')).toBeNull()
    await act(async () => {
      await i18n.changeLanguage('en')
    })
    expect(screen.getByText('No')).toBeTruthy()
    expect(screen.getByText('Yes')).toBeTruthy()
  } finally {
    i18n.removeResourceBundle('fr', 'translation')
  }
})
