// A running agent's resume record (origin 'live' or 'quit') loads to `leaf.resume`, a slept pane's
// to `leaf.sleeping`; both save to the one sleepingAgentSessionsByPaneKey entry, unchanged.

import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../agent-session-resume'
import { LOCAL_EXECUTION_HOST_ID } from '../execution-host'
import { applyLayoutCommand } from './workspace-layout-commands'
import { build, testContext } from './workspace-layout-command.test-fixture'
import { loadWorkspaceLayout } from './workspace-layout-load'
import type { LoadedWorkspaceLayout } from './workspace-layout-load-types'
import type { LayoutLeaf, WorkspaceLayoutModel } from './workspace-layout-model'
import { localDesktopSession, sleepingRecord } from './workspace-layout-profile.test-fixture'
import { publishWorkspaceLayout } from './workspace-layout-published'
import { saveWorkspaceLayout } from './workspace-layout-save'
import { GIT_KEY, leaf } from './workspace-layout-session.test-fixture'
import type { WorkspaceSessionState } from '../workspace-session-state-types'

type Origin = SleepingAgentSessionRecord['origin']
const ORIGINS: readonly Origin[] = ['live', 'quit', 'worktree-sleep', undefined]

function withOrigin(record: SleepingAgentSessionRecord, origin: Origin) {
  const { origin: _stored, ...rest } = record
  return origin ? { ...rest, origin } : rest
}

/** The desktop partition with its agent pane's record captured as `origin`. */
function sessionWith(origin: Origin): WorkspaceSessionState {
  const session = localDesktopSession()
  const paneKey = `term-agent:${leaf(3)}`
  session.sleepingAgentSessionsByPaneKey = {
    [paneKey]: withOrigin(session.sleepingAgentSessionsByPaneKey![paneKey]!, origin)
  }
  return session
}

function load(session: WorkspaceSessionState): LoadedWorkspaceLayout {
  let next = 0
  return loadWorkspaceLayout(LOCAL_EXECUTION_HOST_ID, session, {
    mintId: () => `minted-${++next}`,
    mintLeafId: () => leaf(9)
  })
}

const leafOf = (model: WorkspaceLayoutModel, leafId: string): LayoutLeaf | undefined =>
  model.workspaces[GIT_KEY]!.leaves?.[leafId]

const isSleep = (origin: Origin) => origin === undefined || origin === 'worktree-sleep'

describe("a pane's resume record through load and save", () => {
  it.each(ORIGINS)('loads a %s record to the one holder its origin names', (origin) => {
    const agent = leafOf(load(sessionWith(origin)).layout, leaf(3))!
    expect(agent.sleeping !== undefined).toBe(isSleep(origin))
    expect(agent.resume !== undefined).toBe(!isSleep(origin))
  })

  it.each(ORIGINS)('saves a %s record byte for byte as stored', (origin) => {
    const session = sessionWith(origin)
    const saved = saveWorkspaceLayout(load(session))
    expect(JSON.stringify(saved.sleepingAgentSessionsByPaneKey)).toBe(
      JSON.stringify(session.sleepingAgentSessionsByPaneKey)
    )
  })

  it('never publishes either record to a layout frame', () => {
    const { layout } = load(sessionWith('live'))
    const frame = JSON.stringify(
      publishWorkspaceLayout(layout.workspaces[GIT_KEY]!, LOCAL_EXECUTION_HOST_ID)
    )
    expect(leafOf(layout, leaf(3))!.resume).toBeDefined()
    expect(frame).not.toContain('"resume"')
    expect(frame).not.toContain('fix the flaky test')
  })
})

describe('the sleep, wake and start commands on a resume record', () => {
  const shellPane = `tab-shell:${leaf(1)}`
  const record = (origin: Origin) =>
    withOrigin(sleepingRecord(GIT_KEY, 'tab-shell', leaf(1)), origin)

  it('keeps a recordOnly live capture as a resume record and a real sleep as a sleep', () => {
    const context = testContext()
    const { layout } = load(localDesktopSession())
    const sleep = (origin: Origin, recordOnly?: true) => ({
      type: 'sleep' as const,
      workspace: GIT_KEY,
      paneKeys: [shellPane],
      records: [record(origin)],
      ...(recordOnly ? { recordOnly } : {})
    })
    const live = build(context, [sleep('live', true)], layout).model
    expect(leafOf(live, leaf(1))).toMatchObject({ resume: { origin: 'live' } })
    expect(leafOf(live, leaf(1))!.sleeping).toBeUndefined()
    const slept = build(context, [sleep('worktree-sleep')], live).model
    expect(leafOf(slept, leaf(1))).toMatchObject({ sleeping: { origin: 'worktree-sleep' } })
    expect(leafOf(slept, leaf(1))!.resume).toBeUndefined()
    const recaptured = build(context, [sleep('quit', true)], slept).model
    expect(leafOf(recaptured, leaf(1))).toMatchObject({ resume: { origin: 'quit' } })
    expect(leafOf(recaptured, leaf(1))!.sleeping).toBeUndefined()
    // A recordOnly wake is how a running agent's record is dropped.
    const cleared = build(
      context,
      [{ type: 'wake', workspace: GIT_KEY, paneKeys: [shellPane], recordOnly: true }],
      recaptured
    )
    expect(cleared.results[0]).toEqual({ woken: [shellPane] })
    expect(leafOf(cleared.model, leaf(1))!.resume).toBeUndefined()
  })

  it('a waking start leaves a running agent alone: it keeps its resume record and is not started', () => {
    const context = testContext()
    const { layout } = load(localDesktopSession())
    const live = build(
      context,
      [
        {
          type: 'sleep',
          workspace: GIT_KEY,
          paneKeys: [shellPane],
          records: [record('live')],
          recordOnly: true
        }
      ],
      layout
    ).model
    const woken = applyLayoutCommand(live, { type: 'wake', workspace: GIT_KEY }, context)
    expect(woken).toMatchObject({ ok: true, result: { woken: [] } })
    expect(woken.ok && woken.effects?.startPaneKeys).toEqual([])
    expect(woken.ok && leafOf(woken.model, leaf(1))).toMatchObject({ resume: { origin: 'live' } })
  })

  // C1c: a start resumes the agent from the pane's record, so a record no longer refuses it.
  it('starts an unbound pane holding a resume record, keeping the record to resume from', () => {
    const context = testContext()
    const unboundPane = `tab-unbound:${leaf(4)}`
    const { layout } = load(localDesktopSession())
    const held = build(
      context,
      [
        {
          type: 'sleep',
          workspace: GIT_KEY,
          paneKeys: [unboundPane],
          records: [withOrigin(sleepingRecord(GIT_KEY, 'tab-unbound', leaf(4)), 'quit')],
          recordOnly: true
        }
      ],
      layout
    ).model
    expect(leafOf(held, leaf(4))!.resume).toBeDefined()
    const start = { type: 'startPane' as const, workspace: GIT_KEY, paneKey: unboundPane }
    const started = applyLayoutCommand(held, start, context)
    expect(started.ok && started.effects?.startPaneKeys).toEqual([unboundPane])
    expect(started.ok && leafOf(started.model, leaf(4))!.resume).toBeDefined()
    // A bound pane's resume record does not stop it: its terminal runs.
    const bound = { type: 'startPane' as const, workspace: GIT_KEY, paneKey: shellPane }
    const live = build(
      context,
      [
        {
          type: 'sleep',
          workspace: GIT_KEY,
          paneKeys: [shellPane],
          records: [record('live')],
          recordOnly: true
        }
      ],
      layout
    ).model
    expect(applyLayoutCommand(live, bound, context)).toMatchObject({ ok: true })
  })
})

describe('a resume record moves and closes with its pane', () => {
  it('follows a pane dragged to a new tab, and goes when the pane closes', () => {
    const context = testContext()
    const loaded = load(localDesktopSession())
    const live = build(
      context,
      [
        {
          type: 'sleep',
          workspace: GIT_KEY,
          paneKeys: [`tab-shell:${leaf(2)}`],
          records: [withOrigin(sleepingRecord(GIT_KEY, 'tab-shell', leaf(2)), 'live')],
          recordOnly: true
        }
      ],
      loaded.layout
    ).model
    const moved = build(
      context,
      [{ type: 'movePaneToNewTab', workspace: GIT_KEY, tabId: 'tab-shell', leafId: leaf(2) }],
      live
    )
    const newTab = moved.results[0]!.tabId!
    expect(leafOf(moved.model, leaf(2))).toMatchObject({ resume: { origin: 'live' } })
    const saved = saveWorkspaceLayout({ ...loaded, layout: moved.model })
    expect(saved.sleepingAgentSessionsByPaneKey![`${newTab}:${leaf(2)}`]).toMatchObject({
      paneKey: `${newTab}:${leaf(2)}`,
      tabId: newTab,
      origin: 'live'
    })
    expect(saved.sleepingAgentSessionsByPaneKey![`tab-shell:${leaf(2)}`]).toBeUndefined()
    // After a reload the record is still that pane's resume record.
    expect(leafOf(load(saved).layout, leaf(2))).toMatchObject({ resume: { origin: 'live' } })

    const paneClosed = build(
      context,
      [{ type: 'closePane', workspace: GIT_KEY, tabId: 'tab-shell', leafId: leaf(2) }],
      live
    ).model
    expect(leafOf(paneClosed, leaf(2))).toBeUndefined()
    expect(
      saveWorkspaceLayout({ ...loaded, layout: paneClosed }).sleepingAgentSessionsByPaneKey?.[
        `tab-shell:${leaf(2)}`
      ]
    ).toBeUndefined()

    const closed = build(
      context,
      [{ type: 'closeTabs', workspace: GIT_KEY, tabIds: [newTab] }],
      moved.model
    ).model
    expect(leafOf(closed, leaf(2))).toBeUndefined()
    const afterClose = saveWorkspaceLayout({ ...loaded, layout: closed })
    expect(afterClose.sleepingAgentSessionsByPaneKey![`${newTab}:${leaf(2)}`]).toBeUndefined()
  })
})
