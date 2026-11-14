// Both live/quit resume records and sleep records round-trip through sleepingAgentSessionsByPaneKey, loading into separate mutually exclusive leaf fields.

import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../agent-session/lifecycle/agent-session-resume'
import { LOCAL_EXECUTION_HOST_ID } from '../../execution-host'
import { applyLayoutCommand } from '../workspace-layout-commands'
import { build, testContext } from './workspace-layout-command.test-fixture'
import { loadWorkspaceLayout } from '../persistence/workspace-layout-load'
import type { LoadedWorkspaceLayout } from '../persistence/workspace-layout-load-types'
import type { LayoutLeaf, WorkspaceLayoutModel } from '../workspace-layout-model'
import {
  localDesktopSession,
  sleepingRecord
} from '../persistence/workspace-layout-profile.test-fixture'
import { publishWorkspaceLayout } from '../published-layout/workspace-layout-published'
import '../persistence/workspace-layout-save'
import { GIT_KEY, leaf } from '../persistence/workspace-layout-session.test-fixture'
import type { WorkspaceSessionState } from '../../workspace-session/workspace-session-state-types'

type Origin = SleepingAgentSessionRecord['origin']

function withOrigin(record: SleepingAgentSessionRecord, origin: Origin) {
  const { origin: _stored, ...rest } = record
  return origin ? { ...rest, origin } : rest
}

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

describe("a pane's resume record through load and save", () => {
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
