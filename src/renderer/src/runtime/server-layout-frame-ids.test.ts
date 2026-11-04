import { describe, expect, it } from 'vitest'
import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime/remote-runtime-pty-id'
import '../../../shared/workspace-layout/terminal-surface-id'
import { ownedEditorFileId } from '../../../shared/workspace-session/workspace-session-pane-ownership'
import type {
  PublishedTab,
  PublishedWorkspaceLayout
} from '../../../shared/workspace-layout/workspace-layout-published'
import {
  createServerLayoutFrameTranslator,
  serverLayoutForDesktop,
  type ServerTerminalHandleOf
} from './server-layout-frame-ids'

const ENV = 'env-1'
const WT = 'repo-1::/srv/app'
const OWNED = ownedEditorFileId('/srv/app/b.ts', WT, undefined)

function tab(fields: Partial<PublishedTab> & Pick<PublishedTab, 'id' | 'kind'>): PublishedTab {
  return {
    entityId: fields.id,
    executionHostId: 'local',
    createdAt: 1,
    customTitle: null,
    color: null,
    ...fields
  }
}

function terminal(id: string, entityId: string, leaves: [string, string?][]): PublishedTab {
  return tab({
    id,
    entityId,
    kind: 'terminal',
    terminal: {
      root: { type: 'leaf', leafId: leaves[0]![0] },
      panes: leaves.map(([leafId, ptyId]) => ({ leafId, ...(ptyId ? { ptyId } : {}) }))
    }
  })
}

/** A server's workspace with every id kind: terminals (one with its own tab-bar id), editors by
 *  path and by owned id, a browser tab and a chat. */
function serverLayout(): PublishedWorkspaceLayout {
  return {
    worktreeId: WT,
    groups: [
      { id: 'g-1', tabIds: ['tab-1', 'entry-2', '/srv/app/a.ts', 'ed-2', 'br-1', 'chat-1'] }
    ],
    tabs: [
      terminal('tab-1', 'tab-1', [['leaf-1', 'pty-1'], ['leaf-2']]),
      terminal('entry-2', 'term-2', [['leaf-3', 'pty-3']]),
      tab({ id: '/srv/app/a.ts', kind: 'editor' }),
      tab({ id: 'ed-2', entityId: OWNED, kind: 'editor' }),
      tab({ id: 'br-1', entityId: 'browser-1', kind: 'browser' }),
      tab({ id: 'chat-1', entityId: 'session-1', kind: 'agent-session' })
    ],
    editorFiles: [
      { filePath: '/srv/app/a.ts', relativePath: 'a.ts', language: 'typescript' },
      {
        filePath: '/srv/app/b.ts',
        relativePath: 'b.ts',
        language: 'typescript',
        externalSshTargetId: 'servers-own-target'
      }
    ],
    browserTabs: [{ id: 'browser-1', createdAt: 1 }]
  }
}

/** session.tabs' handles: one per bound pane, named after its host surface. */
const handles: ServerTerminalHandleOf = (hostTabId, leafId) => `term_${hostTabId}_${leafId}`

describe('one server stream translated in order', () => {
  it('re-diffs a records frame under desktop ids, and the same frame twice gives the same ids', () => {
    const before = serverLayout()
    const after = structuredClone(before)
    after.groups[0]!.tabIds.reverse()
    const translator = createServerLayoutFrameTranslator(ENV, () => handles)
    translator.translate({
      type: 'snapshot',
      workspaces: [{ key: WT, layout: before }],
      seq: 1,
      epoch: 'e'
    })
    const frame = translator.translate({
      type: 'records',
      epoch: 'e',
      seq: 2,
      workspaces: [
        { key: WT, change: 'records', workspace: { worktreeId: WT, groups: after.groups } }
      ]
    })
    expect(frame).toMatchObject({
      type: 'records',
      seq: 2,
      workspaces: [
        {
          key: WT,
          change: 'records',
          workspace: {
            groups: [
              { id: 'g-1', tabIds: serverLayoutForDesktop(after, ENV, handles).groups[0]!.tabIds }
            ]
          }
        }
      ]
    })
    const again = createServerLayoutFrameTranslator(ENV, () => handles)
    again.translate({
      type: 'snapshot',
      workspaces: [{ key: WT, layout: after }],
      seq: 2,
      epoch: 'e'
    })
    expect(again.rebind(WT)).toBeNull()
  })

  it('rebinds only the panes whose session.tabs handle changed', () => {
    let known = new Map<string, string>()
    const translator = createServerLayoutFrameTranslator(
      ENV,
      () => (hostTabId, leafId) => known.get(`${hostTabId}/${leafId}`) ?? null
    )
    translator.translate({
      type: 'snapshot',
      workspaces: [{ key: WT, layout: serverLayout() }],
      seq: 4,
      epoch: 'e'
    })
    expect(translator.rebind(WT)).toBeNull()
    known = new Map([['tab-1/leaf-1', 'term_a']])
    expect(translator.rebind(WT)).toEqual({
      type: 'records',
      epoch: 'e',
      seq: 4,
      workspaces: [
        {
          key: WT,
          change: 'records',
          bindings: {
            set: [{ leafId: 'leaf-1', ptyId: toRemoteRuntimePtyId('term_a', ENV) }]
          }
        }
      ]
    })
    expect(translator.rebind(WT)).toBeNull()
  })
})
