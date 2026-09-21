import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { getAgentLabel } from './automation-draft-model'
import {
  AUTOMATION_LIST_SEARCH_PROMPT_MAX_CODE_UNITS,
  AUTOMATION_LIST_SEARCH_UNKNOWN_PROJECT,
  automationListSearchIndexMatches
} from './automation-list-search'
import {
  buildAutomationListSearchRowFingerprint,
  buildAutomationListSearchRows,
  buildAutomationSearchFields,
  buildAutomationSearchRowSources,
  buildExternalAutomationSearchFields,
  buildExternalAutomationSearchRowSources,
  matchAutomationListSearchRowKeys
} from './automation-list-search-rows'
import { buildExternalAutomationListEntries } from './external-automation-list-entries'
import {
  makeAutomation,
  makeAutomationListRow,
  makeScopedExternalManager,
  REPO_ID
} from './automations-page-fixtures'

const repo = { id: REPO_ID, displayName: 'orca', path: '/src/orca' } as Repo
const repoMap = new Map([[REPO_ID, repo]])

function fieldsFor(
  row = makeAutomationListRow({ hostLabel: '' }),
  context: Parameters<typeof buildAutomationSearchFields>[1] = { repoMap }
): ReturnType<typeof buildAutomationSearchFields> {
  return buildAutomationSearchFields(row, context)
}

describe('automation search row fields', () => {
  it('indexes every axis the design doc requires for a local automation', () => {
    const automation = makeAutomation({
      id: 'a-9',
      name: 'Nightly sweep',
      workspaceMode: 'existing',
      workspaceId: 'ws-1',
      agentId: 'claude'
    })
    const fields = fieldsFor(makeAutomationListRow({ automation, hostLabel: 'build-box' }), {
      repoMap,
      worktreeMap: new Map([['ws-1', { displayName: 'feature/login-retry' }]])
    })

    expect(fields).toEqual({
      name: 'Nightly sweep',
      project: 'orca /src/orca',
      workspace: 'feature/login-retry',
      agent: getAgentLabel('claude'),
      host: 'build-box',
      prompt: automation.prompt
    })
  })

  it('falls back to the base ref for automations that create a workspace per run', () => {
    const fields = fieldsFor(
      makeAutomationListRow({
        automation: makeAutomation({ workspaceMode: 'new_per_run', baseBranch: 'main' })
      })
    )
    expect(fields.workspace).toBe('main')
  })

  it('keeps the unknown-project term when no repo resolves', () => {
    const fields = fieldsFor(
      makeAutomationListRow({ automation: makeAutomation({ projectId: 'missing' }) }),
      { repoMap }
    )
    expect(fields.project).toBe(AUTOMATION_LIST_SEARCH_UNKNOWN_PROJECT)
  })

  it('leaves the host axis empty for a row with no host of origin', () => {
    expect(fieldsFor().host).toBe('')
  })

  it('indexes external jobs by provider, target host, and workdir', () => {
    const [entry] = buildExternalAutomationListEntries([makeScopedExternalManager()])
    if (!entry) {
      throw new Error('fixture produced no external entry')
    }
    const fields = buildExternalAutomationSearchFields(entry)
    expect(fields.name).toBe('Hermes job')
    expect(fields.agent).toBe('Hermes')
    expect(fields.host).toBe('This computer')
    expect(fields.prompt).toBe('Sweep')
  })
})

describe('automation search row index', () => {
  it('builds one index per row and matches in a single pass', () => {
    const listRows = [
      makeAutomationListRow({ automation: makeAutomation({ id: 'a-1', name: 'Nightly sweep' }) }),
      makeAutomationListRow({
        automation: makeAutomation({ id: 'a-2', name: 'PR nudge', prompt: 'remind reviewers' }),
        hostLabel: 'build-box'
      })
    ]
    const [first, second] = listRows.map((row) => row.key)
    const rows = buildAutomationListSearchRows(
      buildAutomationSearchRowSources(listRows, { repoMap })
    )

    expect(rows.map((row) => row.key)).toEqual([first, second])
    expect(matchAutomationListSearchRowKeys(rows, 'reviewers')).toEqual([second])
    expect(matchAutomationListSearchRowKeys(rows, 'build-box')).toEqual([second])
    expect(matchAutomationListSearchRowKeys(rows, 'orca')).toEqual([first, second])
    expect(matchAutomationListSearchRowKeys(rows, 'nothing')).toEqual([])
  })

  it('bounds prompt indexing per row regardless of prompt size', () => {
    const prompt = `${'x'.repeat(AUTOMATION_LIST_SEARCH_PROMPT_MAX_CODE_UNITS)}unique-tail`
    const rows = buildAutomationListSearchRows(
      buildAutomationSearchRowSources(
        [makeAutomationListRow({ automation: makeAutomation({ prompt }) })],
        {
          repoMap
        }
      )
    )
    const index = rows[0]?.index
    if (!index) {
      throw new Error('no row built')
    }
    expect(index.prompt.length).toBe(AUTOMATION_LIST_SEARCH_PROMPT_MAX_CODE_UNITS)
    expect(automationListSearchIndexMatches(index, 'unique-tail')).toBe(false)
  })

  it('fingerprints identical content identically across a refresh tick', () => {
    const build = (): ReturnType<typeof buildAutomationSearchRowSources> =>
      buildAutomationSearchRowSources(
        [makeAutomationListRow({ automation: makeAutomation({ nextRunAt: Date.now() }) })],
        { repoMap }
      )
    // Why: nextRunAt churns on every tick and must not invalidate the index.
    expect(buildAutomationListSearchRowFingerprint(build())).toBe(
      buildAutomationListSearchRowFingerprint(build())
    )
  })

  it('changes the fingerprint when a searchable axis changes', () => {
    const base = buildAutomationSearchRowSources([makeAutomationListRow({ hostLabel: '' })], {
      repoMap
    })
    const renamedHost = buildAutomationSearchRowSources(
      [makeAutomationListRow({ hostLabel: 'build-box' })],
      { repoMap }
    )
    expect(buildAutomationListSearchRowFingerprint(base)).not.toBe(
      buildAutomationListSearchRowFingerprint(renamedHost)
    )
  })

  it('fingerprints external rows by key and content', () => {
    const entries = buildExternalAutomationListEntries([makeScopedExternalManager()])
    const sources = buildExternalAutomationSearchRowSources(entries)
    expect(buildAutomationListSearchRowFingerprint(sources)).toBe(
      buildAutomationListSearchRowFingerprint(
        buildExternalAutomationSearchRowSources(
          buildExternalAutomationListEntries([makeScopedExternalManager()])
        )
      )
    )
  })
})
