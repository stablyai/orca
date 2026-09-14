// @vitest-environment happy-dom
import { beforeEach, expect, it } from 'vitest'
import { useFloatingFileViewers } from './floating-file-viewer-state'
import { closeFocusedFileViewer } from './close-focused-file-viewer'

const file = {
  filePath: '/repo/readme.md',
  relativePath: 'readme.md',
  worktreeId: 'folder:test',
  worktreePath: '/repo',
  projectName: 'Project',
  workspaceName: 'Folder',
  language: 'markdown',
  owner: { kind: 'local' as const }
}
beforeEach(() => {
  localStorage.clear()
  useFloatingFileViewers.setState({ viewers: [], hidden: false })
})
it('closes only the focused viewer, never a background viewer', () => {
  useFloatingFileViewers.getState().open(file)
  const panel = document.createElement('div')
  panel.tabIndex = -1
  panel.setAttribute('data-floating-file-viewer', useFloatingFileViewers.getState().viewers[0].id)
  document.body.append(panel)
  expect(closeFocusedFileViewer()).toBe(false)
  panel.focus()
  expect(closeFocusedFileViewer()).toBe(true)
  expect(useFloatingFileViewers.getState().viewers).toHaveLength(0)
  panel.remove()
})
it('deduplicates by owner and file, raises existing windows, and preserves geometry', () => {
  const state = useFloatingFileViewers.getState()
  state.open(file)
  const id = useFloatingFileViewers.getState().viewers[0].id
  state.setBounds(id, { left: 50, top: 100, width: 500, height: 400 })
  state.open({ ...file, owner: { kind: 'ssh', connectionId: 'remote' } })
  state.toggleHidden()
  state.open(file)
  expect(useFloatingFileViewers.getState().viewers).toHaveLength(2)
  expect(useFloatingFileViewers.getState().viewers.at(-1)).toMatchObject({
    id,
    bounds: { left: 50, width: 500 }
  })
  expect(useFloatingFileViewers.getState().hidden).toBe(false)
  state.close(id)
  expect(useFloatingFileViewers.getState().viewers).toHaveLength(1)
})
it('restores hidden windows without persisting file contents and ignores corrupt storage', async () => {
  useFloatingFileViewers.getState().open(file)
  useFloatingFileViewers.getState().toggleHidden()
  const saved = localStorage.getItem('orca-floating-file-viewers-v1')!
  expect(saved).not.toContain('content')
  useFloatingFileViewers.setState({ viewers: [], hidden: false })
  localStorage.setItem('orca-floating-file-viewers-v1', saved)
  await useFloatingFileViewers.persist.rehydrate()
  expect(useFloatingFileViewers.getState().hidden).toBe(true)
  expect(useFloatingFileViewers.getState().viewers).toHaveLength(1)
  localStorage.setItem(
    'orca-floating-file-viewers-v1',
    JSON.stringify({ state: { viewers: [{}], hidden: false }, version: 0 })
  )
  await useFloatingFileViewers.persist.rehydrate()
  expect(useFloatingFileViewers.getState().viewers).toHaveLength(1)
})
