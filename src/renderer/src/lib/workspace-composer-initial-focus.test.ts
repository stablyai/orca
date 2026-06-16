// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { getWorkspaceComposerInitialFocusTarget } from './workspace-composer-initial-focus'

describe('getWorkspaceComposerInitialFocusTarget', () => {
  it('focuses the project combobox used by the current workspace composer', () => {
    const root = document.createElement('div')
    const projectTrigger = document.createElement('button')
    projectTrigger.setAttribute('role', 'combobox')
    projectTrigger.setAttribute('data-project-combobox-root', 'true')
    root.append(projectTrigger)

    expect(getWorkspaceComposerInitialFocusTarget(root)).toBe(projectTrigger)
  })

  it('prefers project focus when both current and legacy triggers exist', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <button role="combobox" data-repo-combobox-root="true"></button>
      <button role="combobox" data-project-combobox-root="true"></button>
    `

    expect(getWorkspaceComposerInitialFocusTarget(root)).toBe(
      root.querySelector('[data-project-combobox-root="true"]')
    )
  })

  it('keeps a legacy repo-combobox fallback for alternate composer surfaces', () => {
    const root = document.createElement('div')
    const repoTrigger = document.createElement('button')
    repoTrigger.setAttribute('role', 'combobox')
    repoTrigger.setAttribute('data-repo-combobox-root', 'true')
    root.append(repoTrigger)

    expect(getWorkspaceComposerInitialFocusTarget(root)).toBe(repoTrigger)
  })
})
