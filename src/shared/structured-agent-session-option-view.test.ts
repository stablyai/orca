import { describe, expect, it } from 'vitest'
import { CLAUDE_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-claude-codex'
import type { AgentSessionModelCatalogResult } from './agent-session-wire'
import {
  applyStructuredAgentSessionModelCatalog,
  applyStructuredAgentSessionOptions,
  commitStructuredAgentSessionOption,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot,
  type StructuredAgentSessionOptionState
} from './structured-agent-session-options'
import {
  structuredAgentSessionOptionView,
  structuredAgentSessionSendSelection,
  structuredAgentSessionShownSnapshot
} from './structured-agent-session-option-view'

const levels = (...values: string[]) => values.map((value) => ({ value, label: value }))
const OPUS = { id: 'opus[1m]', label: 'Opus', isDefault: false, efforts: levels('low', 'xhigh') }
const SONNET = { id: 'sonnet', label: 'Sonnet', isDefault: false, efforts: levels('low', 'high') }
// Claude's session-less listing marks no default row.
const LISTED: AgentSessionModelCatalogResult = { origin: 'probe', fetchedAt: 1, models: [OPUS] }
const remembered = { model: 'claude-gone', effort: 'max' }
// Claude Code 2.1.302 lists plain opus and no opus[1m], which still runs.
const CLI302 = [{ ...OPUS, id: 'opus', isDefault: true }, SONNET]

const fresh = () => createStructuredAgentSessionOptionState('claude', CLAUDE_SESSION_OPTION_CATALOG)
const withHostList = (state = fresh(), catalog: AgentSessionModelCatalogResult = LISTED) =>
  applyStructuredAgentSessionModelCatalog(state, CLAUDE_SESSION_OPTION_CATALOG, catalog, {
    newLaunch: true
  })
// A chat's own answer lists its listing's rows plus its own model, named by its id; `listed` are
// the ids its listing names (none from an older host).
const stopped = (
  model: string,
  rows = [OPUS],
  listed = rows.map((row) => row.id),
  effort = 'high'
) =>
  applyStructuredAgentSessionOptions(fresh(), CLAUDE_SESSION_OPTION_CATALOG, {
    models: [...rows, { id: model, label: model, isDefault: false, efforts: [] }],
    listedModelIds: listed,
    current: { model, effort }
  })

function shown(...args: Parameters<typeof structuredAgentSessionOptionView>) {
  const snapshot = structuredAgentSessionOptionSnapshot(structuredAgentSessionOptionView(...args))
  const value = (id: string) => {
    const kind = snapshot.find((descriptor) => descriptor.id === id)?.kind
    return kind?.type === 'select' ? kind.currentValue : undefined
  }
  return { model: value('model'), effort: value('effort') }
}

const carried = (
  state: StructuredAgentSessionOptionState,
  seed?: Readonly<Record<string, string>>,
  picks: Readonly<Record<string, string>> = {}
) => structuredAgentSessionSendSelection(structuredAgentSessionOptionView(state, seed, picks))

describe('a Claude model its CLI no longer lists', () => {
  it('stays the chat model through a refresh and every send, its effort read-only', () => {
    // The incident: a chat on opus[1m] at max, reopened under a CLI that lists only plain opus.
    const restored = withHostList(stopped('opus[1m]', CLI302, undefined, 'max'), {
      ...LISTED,
      models: CLI302
    })
    const refreshed = applyStructuredAgentSessionOptions(restored, CLAUDE_SESSION_OPTION_CATALOG, {
      models: [...CLI302, { id: 'opus[1m]', label: 'opus[1m]', isDefault: false, efforts: [] }],
      listedModelIds: CLI302.map((row) => row.id),
      current: { model: 'opus[1m]', effort: 'max' }
    })
    for (const state of [restored, refreshed]) {
      expect(shown(state, undefined, {})).toEqual({ model: 'opus[1m]', effort: 'max' })
      expect(carried(state)).toEqual({ model: 'opus[1m]', effort: 'max' })
      const snapshot = structuredAgentSessionShownSnapshot(state)
      // No inferred menu: the one level it holds, which nothing can change.
      expect(snapshot.find((entry) => entry.id === 'effort')).toMatchObject({
        settable: false,
        kind: { choices: [{ value: 'max', label: 'max' }] }
      })
    }
  })

  it('keeps a remembered model and effort, including under a model with no listed effort', () => {
    // The placeholder stands until the host answers with the chat's own model; create seeds it.
    expect(carried(withHostList(), remembered)).toBeUndefined()
    const haiku = { id: 'haiku', label: 'Haiku', isDefault: false, efforts: [] }
    const listed = applyStructuredAgentSessionOptions(fresh(), CLAUDE_SESSION_OPTION_CATALOG, {
      models: [OPUS, haiku],
      listedModelIds: ['opus[1m]', 'haiku'],
      current: { model: 'haiku', effort: 'high' }
    })
    expect(shown(listed, undefined, {})).toEqual({ model: 'haiku', effort: 'high' })
  })
})

describe('what a send carries', () => {
  it('carries the default it shows when nothing names a model', () => {
    const named = { ...SONNET, isDefault: true }
    const listing = { ...LISTED, models: [OPUS, named], listingNamesConfiguredModel: true }
    expect(carried(withHostList(fresh(), listing))).toEqual({ model: 'sonnet' })
  })

  it('carries a pick on its way as given', () => {
    const listed = withHostList(fresh(), { ...LISTED, models: [OPUS, SONNET] })
    expect(carried(listed, remembered, { model: 'sonnet' })).toMatchObject({ model: 'sonnet' })
    expect(carried(withHostList(), undefined, { model: 'claude-retired' })).toMatchObject({
      model: 'claude-retired'
    })
  })

  it('carries nothing before a model shows, or for another agent', () => {
    expect(carried(fresh())).toBeUndefined()
    const codex = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('codex', CLAUDE_SESSION_OPTION_CATALOG),
      CLAUDE_SESSION_OPTION_CATALOG,
      { models: [OPUS], current: { model: 'opus[1m]' } }
    )
    expect(carried(codex)).toBeUndefined()
  })
})

describe("a chat's model and effort, apart from the defaults filling them in", () => {
  const listed = CLI302.map((row) => row.id)
  // A resumed chat at rest that never picked a model: its host fills in the listing's default.
  const resumed = (defaulted?: readonly ('model' | 'effort')[]) =>
    applyStructuredAgentSessionOptions(
      applyStructuredAgentSessionModelCatalog(
        fresh(),
        CLAUDE_SESSION_OPTION_CATALOG,
        { ...LISTED, models: CLI302 },
        { newLaunch: false }
      ),
      CLAUDE_SESSION_OPTION_CATALOG,
      {
        models: CLI302,
        listedModelIds: listed,
        current: { model: 'opus', effort: 'low', ...(defaulted ? { defaulted } : {}) }
      }
    )

  it("names a resumed chat's defaults but never sends them, only its picks", () => {
    const state = resumed(['model', 'effort'])
    expect(shown(state, undefined, {})).toEqual({ model: 'opus', effort: 'low' })
    expect(carried(state)).toBeUndefined()
    const effort = commitStructuredAgentSessionOption(state, 'effort', 'xhigh')
    expect(carried(effort)).toEqual({ effort: 'xhigh' })
  })

  it("reads an older host's answer, which marks no default, as it always has", () => {
    const state = resumed()
    expect(shown(state, undefined, {})).toEqual({ model: 'opus', effort: 'low' })
    expect(carried(state)).toEqual({ model: 'opus', effort: 'low' })
  })

  it('lets a new chat pick its effort before its first message, under the default it shows', () => {
    const state = withHostList(fresh(), {
      ...LISTED,
      models: CLI302,
      listingNamesConfiguredModel: true
    })
    expect(shown(state, undefined, { effort: 'xhigh' })).toEqual({ model: 'opus', effort: 'xhigh' })
    expect(carried(state, undefined, { effort: 'xhigh' })).toEqual({
      model: 'opus',
      effort: 'xhigh'
    })
  })
})
