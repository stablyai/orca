// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { getWorkspaceComposerInitialFocusTarget } from './workspace-composer-initial-focus'

describe('getWorkspaceComposerInitialFocusTarget', () => {
  it('focuses the workspace name input used by the current composer', () => {
    const root = document.createElement('div')
    const nameInput = document.createElement('input')
    nameInput.setAttribute('data-workspace-name-input', 'true')
    root.append(nameInput)

    expect(getWorkspaceComposerInitialFocusTarget(root)).toBe(nameInput)
  })

  it('prefers the name input when both name and project triggers exist', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <button role="combobox" data-project-combobox-root="true"></button>
      <input data-workspace-name-input="true" />
    `

    expect(getWorkspaceComposerInitialFocusTarget(root)).toBe(
      root.querySelector('[data-workspace-name-input="true"]')
    )
  })

  it('focuses the source pill when the name input is replaced by a selection', () => {
    const root = document.createElement('div')
    const pill = document.createElement('div')
    pill.setAttribute('data-workspace-source-pill', 'true')
    pill.setAttribute('tabindex', '0')
    root.append(pill)

    expect(getWorkspaceComposerInitialFocusTarget(root)).toBe(pill)
  })

  it('prefers the source pill over the project combobox when both exist', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <button role="combobox" data-project-combobox-root="true"></button>
      <div data-workspace-source-pill="true" tabindex="0"></div>
    `

    expect(getWorkspaceComposerInitialFocusTarget(root)).toBe(
      root.querySelector('[data-workspace-source-pill="true"]')
    )
  })

  it('falls back to the project combobox when the name input is absent', () => {
    const root = document.createElement('div')
    const projectTrigger = document.createElement('button')
    projectTrigger.setAttribute('role', 'combobox')
    projectTrigger.setAttribute('data-project-combobox-root', 'true')
    root.append(projectTrigger)

    expect(getWorkspaceComposerInitialFocusTarget(root)).toBe(projectTrigger)
  })

  it('prefers project focus over legacy repo trigger when the name input is absent', () => {
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
