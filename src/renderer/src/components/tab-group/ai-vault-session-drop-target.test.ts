// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { resolvePaneDropTarget } from './ai-vault-session-drop-target'

afterEach(() => {
  document.body.replaceChildren()
})

describe('resolvePaneDropTarget', () => {
  it('returns the pane and overlay under the drop point', () => {
    const element = document.createElement('div')
    element.dataset.tabGroupBodyId = 'group-1'
    element.dataset.worktreeId = 'worktree-1'
    element.getBoundingClientRect = () => new DOMRect(10, 20, 200, 100)
    document.body.append(element)

    expect(
      resolvePaneDropTarget('worktree-1', new DOMRect(0, 0, 400, 300), { x: 100, y: 70 })
    ).toEqual({
      groupId: 'group-1',
      zone: 'center',
      overlayStyle: { left: 10, top: 20, width: 200, height: 100 }
    })
  })
})
