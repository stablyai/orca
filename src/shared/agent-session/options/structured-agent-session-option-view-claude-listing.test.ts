import { describe, expect, it } from 'vitest'
import { CLAUDE_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-claude-codex'
import {
  acceptedStructuredSessionSelectionOutcome,
  createStructuredAgentSessionOptionsWriteOwner
} from './structured-agent-session-options-write-owner'
import { createStructuredSessionSelectionController } from './structured-agent-session-selection-operations'
import { applyNativeChatSessionOptionPicks } from '../../native-chat/input/native-chat-session-option-defaults'
import {
  applyStructuredAgentSessionModelCatalog,
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState,
  type StructuredAgentSessionOptionState
} from './structured-agent-session-options'
import {
  structuredAgentSessionOptionView,
  structuredAgentSessionSendSelection,
  structuredAgentSessionShownSnapshot
} from './structured-agent-session-option-view'

type RememberedPicks = Parameters<
  Parameters<typeof createStructuredSessionSelectionController>[0]
>[0][number][]

const levels = (...values: string[]) => values.map((value) => ({ value, label: value }))
const fresh = () => createStructuredAgentSessionOptionState('claude', CLAUDE_SESSION_OPTION_CATALOG)
const carried = (
  state: StructuredAgentSessionOptionState,
  seed?: Readonly<Record<string, string>>,
  picks: Readonly<Record<string, string>> = {}
) => structuredAgentSessionSendSelection(structuredAgentSessionOptionView(state, seed, picks))

describe('a Claude listing keyed by the model each row runs', () => {
  // Claude Code 2.1.318's rows as the host lists them now: a versioned row, then its alias.
  const EFFORTS = levels('low', 'medium', 'high', 'xhigh', 'max')
  const row = (id: string, label: string, resolvedModel: string, efforts = EFFORTS) => ({
    id,
    label,
    resolvedModel,
    isDefault: false,
    efforts
  })
  const ROWS = [
    row('claude-opus-5-5', 'Claude Opus 5.5', 'claude-opus-5-5'),
    row('claude-sonnet-5-5', 'Claude Sonnet 5.5', 'claude-sonnet-5-5', levels('low', 'high')),
    row('opus', 'Opus alias', 'claude-opus-5-5'),
    row('sonnet', 'Sonnet alias', 'claude-sonnet-5-5', levels('low', 'high'))
  ]
  const chat = (model: string, rows = ROWS, effort = 'low') =>
    applyStructuredAgentSessionOptions(
      applyStructuredAgentSessionModelCatalog(
        fresh(),
        CLAUDE_SESSION_OPTION_CATALOG,
        { origin: 'probe', fetchedAt: 1, models: rows },
        { newLaunch: false, coherentCatalog: true }
      ),
      CLAUDE_SESSION_OPTION_CATALOG,
      { models: rows, listedModelIds: rows.map(({ id }) => id), current: { model, effort } },
      { newLaunch: false, coherentCatalog: true }
    )
  const rowOf = (state: StructuredAgentSessionOptionState, id: string) =>
    structuredAgentSessionShownSnapshot(state).find((entry) => entry.id === id)
  const mainList = (state: StructuredAgentSessionOptionState) => {
    const kind = rowOf(state, 'model')?.kind
    return kind?.type === 'select'
      ? kind.choices.filter((choice) => !choice.searchOnly).map((choice) => choice.value)
      : []
  }

  it('lists the versioned rows, an alias only while the chat is on it', () => {
    expect(mainList(chat('claude-opus-5-5'))).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
    expect(mainList(chat('opus'))).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'opus'])
    // An older host keys rows by alias alone: every row stays in the list.
    const older = ROWS.slice(2).map((alias) => ({ ...alias, label: alias.id }))
    expect(mainList(chat('opus', older))).toEqual(['opus', 'sonnet'])
  })

  it('applies effort to a versioned chat and keeps sending the id it runs', () => {
    const state = chat('claude-opus-5-5')
    expect(rowOf(state, 'effort')).toMatchObject({ settable: true, kind: { choices: EFFORTS } })
    expect(carried(state, undefined, { effort: 'max' })).toEqual({
      model: 'claude-opus-5-5',
      effort: 'max'
    })
  })

  it('keeps a saved alias, with its own row’s levels', () => {
    const state = chat('sonnet', ROWS, 'high')
    expect(rowOf(state, 'effort')).toMatchObject({
      settable: true,
      kind: { currentValue: 'high', choices: levels('low', 'high') }
    })
    expect(carried(state, undefined, { effort: 'low' })).toEqual({ model: 'sonnet', effort: 'low' })
  })

  it('remembers an effort picked in a chat under its model, never adopting it for new chats', async () => {
    const state = chat('claude-opus-5-5')
    const remembered: RememberedPicks = []
    const controller = createStructuredSessionSelectionController((picks) => {
      remembered.push(...picks)
    })
    const writer = createStructuredAgentSessionOptionsWriteOwner(() => {
      const view = structuredAgentSessionOptionView(state, undefined, controller.overlay())
      return {
        controller,
        record: state.record,
        view,
        snapshot: structuredAgentSessionShownSnapshot(view),
        ready: true,
        providerStarting: false,
        isCurrentContext: () => true,
        flush: () =>
          controller.flush(async (pick) => acceptedStructuredSessionSelectionOutcome(pick)),
        revalidate: () => {},
        revalidateOn: 'refused-current'
      }
    })
    expect(await writer.setOption('effort', 'high')).toBe(true)
    expect(remembered).toEqual([
      {
        modelId: 'claude-opus-5-5',
        optionId: 'effort',
        value: 'high',
        adoptModelAsLaunchDefault: false
      }
    ])
    const next = applyNativeChatSessionOptionPicks({
      persisted: { claude: { model: 'sonnet', valuesByModel: {} } },
      agent: 'claude',
      picks: remembered
    })
    expect(next.claude?.model).toBe('sonnet')
  })
})
