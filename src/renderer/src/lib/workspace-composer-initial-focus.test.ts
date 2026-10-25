// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getWorkspaceComposerInitialFocusTarget,
  isComposerProjectSelectShortcut,
  openWorkspaceComposerProjectSelect
} from './workspace-composer-initial-focus'

function setUserAgent(userAgent: string): void {
  vi.stubGlobal('navigator', { userAgent })
}

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

describe('isComposerProjectSelectShortcut', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses Cmd+. on macOS and Ctrl+. elsewhere', () => {
    setUserAgent('Macintosh')
    expect(isComposerProjectSelectShortcut({ key: '.', metaKey: true })).toBe(true)
    expect(isComposerProjectSelectShortcut({ key: '。', code: 'Period', metaKey: true })).toBe(
      true
    )
    expect(isComposerProjectSelectShortcut({ key: '.', ctrlKey: true })).toBe(false)

    setUserAgent('Linux')
    expect(isComposerProjectSelectShortcut({ key: '.', ctrlKey: true })).toBe(true)
    expect(isComposerProjectSelectShortcut({ key: '.', metaKey: true })).toBe(false)
  })

  it('ignores extra modifiers, non-period keys, and composing events', () => {
    setUserAgent('Macintosh')
    expect(isComposerProjectSelectShortcut({ key: '.', metaKey: true, shiftKey: true })).toBe(
      false
    )
    expect(isComposerProjectSelectShortcut({ key: '.', metaKey: true, altKey: true })).toBe(false)
    expect(isComposerProjectSelectShortcut({ key: '.', metaKey: true, ctrlKey: true })).toBe(false)

    setUserAgent('Linux')
    expect(isComposerProjectSelectShortcut({ key: 'Enter', ctrlKey: true })).toBe(false)
    expect(isComposerProjectSelectShortcut({ key: '.', ctrlKey: true, isComposing: true })).toBe(
      false
    )
  })
})

describe('openWorkspaceComposerProjectSelect', () => {
  it('clicks the project combobox shell to open it', () => {
    const root = document.createElement('div')
    const shell = document.createElement('div')
    shell.setAttribute('data-project-combobox-root', 'true')
    const click = vi.fn()
    shell.addEventListener('click', click)
    root.append(shell)

    expect(openWorkspaceComposerProjectSelect(root)).toBe(true)
    expect(click).toHaveBeenCalledTimes(1)
  })

  it('returns false when no project picker exists', () => {
    expect(openWorkspaceComposerProjectSelect(document.createElement('div'))).toBe(false)
  })
})
