import { describe, expect, it, vi } from 'vitest'
import { ownedEditorFileId } from '../workspace-session/workspace-session-pane-ownership'
import { build, testContext, WS } from './workspace-layout-command.test-fixture'

import type { LayoutEditorFile } from './workspace-layout-model'

vi.mock('../layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

function file(filePath: string, runtimeEnvironmentId?: string): LayoutEditorFile {
  return {
    filePath,
    relativePath: filePath.slice(1),
    language: 'typescript',
    ...(runtimeEnvironmentId ? { runtimeEnvironmentId } : {})
  }
}

describe('an open main makes itself, naming the file but not its id', () => {
  const opened = file('/repo/a.ts')

  it('opens the file under its owned id', () => {
    const { model, results } = build(testContext(), [
      { type: 'openEditorTab', workspace: WS, contentType: 'editor', file: opened }
    ])
    const tab = model.workspaces[WS]!.tabs.find((entry) => entry.id === results[0]!.tabId)
    expect(tab?.entityId).toBe(ownedEditorFileId('/repo/a.ts', WS, null))
    expect(model.workspaces[WS]!.editorFiles).toEqual([opened])
  })

  it('shows the tab it already has for the file in that group', () => {
    const { results } = build(testContext(), [
      { type: 'openEditorTab', workspace: WS, contentType: 'editor', file: opened },
      { type: 'openEditorTab', workspace: WS, contentType: 'editor', file: opened }
    ])
    expect(results[1]!.tabId).toBe(results[0]!.tabId)
  })
})
