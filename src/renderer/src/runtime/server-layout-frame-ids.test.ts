import { describe, expect, it } from 'vitest'
import {
  toRemoteRuntimePtyId,
  parseRemoteRuntimePtyId
} from '../../../shared/remote-runtime/remote-runtime-pty-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { ownedEditorFileId } from '../../../shared/workspace-session-pane-ownership'
import type {
  PublishedTab,
  PublishedWorkspaceLayout
} from '../../../shared/workspace-layout/workspace-layout-published'
import {
  createServerLayoutFrameTranslator,
  desktopLayoutForServer,
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

describe('a server layout under desktop ids', () => {
  const desktop = serverLayoutForDesktop(serverLayout(), ENV, handles)

  it('names each id the way the session.tabs mirror names it', () => {
    expect(desktop.groups[0]!.tabIds).toEqual([
      toWebTerminalSurfaceTabId('tab-1'),
      toWebTerminalSurfaceTabId('term-2'),
      '/srv/app/a.ts',
      'ed-2',
      'br-1',
      'chat-1'
    ])
    expect(desktop.tabs.map((entry) => [entry.id, entry.entityId])).toEqual([
      [toWebTerminalSurfaceTabId('tab-1'), toWebTerminalSurfaceTabId('tab-1')],
      [toWebTerminalSurfaceTabId('term-2'), toWebTerminalSurfaceTabId('term-2')],
      // The mirror names every server file by its owned id, as a restart restores it.
      ['/srv/app/a.ts', ownedEditorFileId('/srv/app/a.ts', WT, ENV)],
      ['ed-2', ownedEditorFileId('/srv/app/b.ts', WT, ENV)],
      ['br-1', 'browser-1'],
      ['chat-1', 'session-1']
    ])
    expect(new Set(desktop.tabs.map((entry) => entry.executionHostId))).toEqual(
      new Set(['runtime:env-1'])
    )
    expect(desktop.editorFiles).toEqual([
      {
        filePath: '/srv/app/a.ts',
        relativePath: 'a.ts',
        language: 'typescript',
        runtimeEnvironmentId: ENV
      },
      {
        filePath: '/srv/app/b.ts',
        relativePath: 'b.ts',
        language: 'typescript',
        runtimeEnvironmentId: ENV
      }
    ])
    expect(desktop.browserTabs).toEqual(serverLayout().browserTabs)
  })

  it('names a bare-path tab by its path when the server holds that path under two owners', () => {
    const layout = serverLayout()
    const both: PublishedWorkspaceLayout = {
      ...layout,
      editorFiles: [
        {
          filePath: '/srv/app/a.ts',
          relativePath: 'a.ts',
          language: 'typescript',
          runtimeEnvironmentId: 'other-env'
        },
        ...layout.editorFiles
      ]
    }
    const mapped = serverLayoutForDesktop(both, ENV, handles)
    expect(mapped.tabs.find((entry) => entry.id === '/srv/app/a.ts')?.entityId).toBe(
      ownedEditorFileId('/srv/app/a.ts', WT, ENV)
    )
  })

  it('binds a pane to its session.tabs handle, and a bound pane without one stays pending', () => {
    const panes = desktop.tabs[0]!.terminal!.panes
    expect(panes[0]).toEqual({
      leafId: 'leaf-1',
      ptyId: toRemoteRuntimePtyId('term_tab-1_leaf-1', ENV)
    })
    expect(panes[1]).toEqual({ leafId: 'leaf-2' })
    const pending = serverLayoutForDesktop(serverLayout(), ENV, () => null)
    expect(pending.tabs[0]!.terminal!.panes[0]).toEqual({ leafId: 'leaf-1' })
  })

  it('maps every id kind desktop to server to desktop as the identity', () => {
    const handleOfPtyId: ServerTerminalHandleOf = (hostTabId, leafId) => {
      const pane = desktop.tabs
        .find((entry) => entry.entityId === toWebTerminalSurfaceTabId(hostTabId))
        ?.terminal?.panes.find((candidate) => candidate.leafId === leafId)
      return pane?.ptyId ? parseRemoteRuntimePtyId(pane.ptyId)!.handle : null
    }
    // The server's own panes are bound wherever the desktop's are.
    const server = desktopLayoutForServer(desktop)
    const boundServer = {
      ...server,
      tabs: server.tabs.map((entry) =>
        entry.terminal
          ? {
              ...entry,
              terminal: {
                ...entry.terminal,
                panes: entry.terminal.panes.map((pane) =>
                  handleOfPtyId(entry.entityId, pane.leafId) ? { ...pane, ptyId: 'bound' } : pane
                )
              }
            }
          : entry
      )
    }
    expect(serverLayoutForDesktop(boundServer, ENV, handleOfPtyId)).toEqual(desktop)
  })

  it('refuses a tab kind it does not know rather than show it under raw ids', () => {
    const layout = serverLayout()
    // Through JSON, as the wire delivers it: no TabContentType names this kind.
    const future: PublishedTab = JSON.parse(
      JSON.stringify({ ...layout.tabs[2]!, id: 'future-1', kind: 'hologram' })
    )
    layout.tabs.push(future)
    expect(() => serverLayoutForDesktop(layout, ENV, handles)).toThrow('unknown tab kind')
  })
})

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
