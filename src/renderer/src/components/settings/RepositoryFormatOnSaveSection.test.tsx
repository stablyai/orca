// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Repo, RepoFormatOnSaveSettings } from '../../../../shared/repo-types'
import { SUGGESTED_FORMAT_ON_SAVE_INCLUDE } from '../../../../shared/format-on-save-command'
import { RepositoryFormatOnSaveSection } from './RepositoryFormatOnSaveSection'

let container: HTMLDivElement
let root: Root
let onUpdateFormatOnSave: Mock<(next: RepoFormatOnSaveSettings) => void>

const baseRepo: Repo = {
  id: 'repo-1',
  path: '/tmp/repo',
  displayName: 'Example Repo',
  badgeColor: '#000000',
  addedAt: 1,
  kind: 'git'
}

function render(repo: Repo = baseRepo, searchQuery = ''): void {
  act(() => {
    root.render(
      React.createElement(RepositoryFormatOnSaveSection, {
        repo,
        searchQuery,
        onUpdateFormatOnSave
      })
    )
  })
}

function input(id: string): HTMLInputElement {
  const element = container.querySelector<HTMLInputElement>(`#${id}`)
  if (!element) {
    throw new Error(`missing input ${id}`)
  }
  return element
}

function type(id: string, value: string): HTMLInputElement {
  const element = input(id)
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
  return element
}

function typeAndBlur(id: string, value: string): void {
  const element = type(id, value)
  act(() => {
    // Why: React delegates blur through the bubbling focusout event.
    element.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
}

beforeEach(() => {
  onUpdateFormatOnSave = vi.fn<(next: RepoFormatOnSaveSettings) => void>()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('RepositoryFormatOnSaveSection', () => {
  it('hides itself when the settings search excludes it', () => {
    render(baseRepo, 'zzz-no-such-setting')
    expect(container.textContent).toBe('')
  })

  it('stays visible for a matching settings search', () => {
    render(baseRepo, 'formatter')
    expect(container.textContent).toContain('Format on Save')
  })

  it('tells the user why the toggle cannot be turned on yet', () => {
    render()
    expect(container.textContent).toContain('Set a formatter command below to turn this on.')
  })

  it('points at the command field when the switch is clicked without one', () => {
    render()
    act(() => container.querySelector<HTMLButtonElement>('[role="switch"]')?.click())

    const command = input('format-on-save-command')
    expect(command.getAttribute('aria-invalid')).toBe('true')
    expect(command.parentElement?.className).toContain('animate-format-on-save-command-nudge')
    expect(document.activeElement).toBe(command)
    // Why: nothing may be written — a command-less enabled config reads back as off.
    expect(onUpdateFormatOnSave).not.toHaveBeenCalled()
  })

  it('clears the invalid state as soon as the user types a command', () => {
    render()
    act(() => container.querySelector<HTMLButtonElement>('[role="switch"]')?.click())
    expect(input('format-on-save-command').getAttribute('aria-invalid')).toBe('true')

    typeAndBlur('format-on-save-command', 'prettier --write ${file}')
    expect(input('format-on-save-command').getAttribute('aria-invalid')).toBeNull()
  })

  it('turns the feature on when a command is already configured', () => {
    render({
      ...baseRepo,
      formatOnSave: { enabled: false, command: 'prettier --write ${file}', include: [] }
    })
    act(() => container.querySelector<HTMLButtonElement>('[role="switch"]')?.click())

    expect(onUpdateFormatOnSave).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }))
    expect(input('format-on-save-command').getAttribute('aria-invalid')).toBeNull()
  })

  it('stops nudging once the animation finishes', () => {
    render()
    act(() => container.querySelector<HTMLButtonElement>('[role="switch"]')?.click())

    const wrapper = input('format-on-save-command').parentElement
    act(() => {
      wrapper?.dispatchEvent(new Event('animationend', { bubbles: true }))
    })
    expect(wrapper?.className).not.toContain('animate-format-on-save-command-nudge')
  })

  it('commits a typed command on blur', () => {
    render()
    typeAndBlur('format-on-save-command', '  npx prettier --write ${file}  ')

    expect(onUpdateFormatOnSave).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'npx prettier --write ${file}' })
    )
  })

  it('parses the include field into globs', () => {
    render({
      ...baseRepo,
      formatOnSave: { enabled: true, command: 'prettier --write ${file}', include: [] }
    })
    typeAndBlur('format-on-save-include', '**/*.ts, **/*.md')

    expect(onUpdateFormatOnSave).toHaveBeenCalledWith(
      expect.objectContaining({ include: ['**/*.ts', '**/*.md'] })
    )
  })

  it('clearing the command also turns the feature off', () => {
    render({
      ...baseRepo,
      formatOnSave: { enabled: true, command: 'prettier --write ${file}', include: [] }
    })
    typeAndBlur('format-on-save-command', '')

    const next = onUpdateFormatOnSave.mock.calls[0][0]
    expect(next).toEqual(expect.objectContaining({ command: '', enabled: false }))
  })

  it('does not write back when the field is left unchanged', () => {
    render({
      ...baseRepo,
      formatOnSave: { enabled: true, command: 'prettier --write ${file}', include: ['**/*.ts'] }
    })
    typeAndBlur('format-on-save-command', 'prettier --write ${file}')
    typeAndBlur('format-on-save-include', '**/*.ts')

    expect(onUpdateFormatOnSave).not.toHaveBeenCalled()
  })

  it('keeps an unfinished include edit when only the stored command changes', () => {
    const formatOnSave = { enabled: true, command: 'prettier --write ${file}', include: [] }
    render({ ...baseRepo, formatOnSave })
    type('format-on-save-include', '**/*.{ts,tsx')

    render({
      ...baseRepo,
      formatOnSave: { ...formatOnSave, command: 'biome format --write ${file}' }
    })

    expect(input('format-on-save-include').value).toBe('**/*.{ts,tsx')
    expect(input('format-on-save-command').value).toBe('biome format --write ${file}')
  })

  it('keeps an unfinished command edit when only the stored include list changes', () => {
    const formatOnSave = { enabled: true, command: 'prettier --write ${file}', include: [] }
    render({ ...baseRepo, formatOnSave })
    type('format-on-save-command', 'prettier --check ${file}')

    render({ ...baseRepo, formatOnSave: { ...formatOnSave, include: ['**/*.ts'] } })

    expect(input('format-on-save-command').value).toBe('prettier --check ${file}')
    expect(input('format-on-save-include').value).toBe('**/*.ts')
  })

  it('shows the suggested brace pattern without splitting it', () => {
    render({
      ...baseRepo,
      formatOnSave: { enabled: true, command: 'prettier --write ${file}', include: [] }
    })
    typeAndBlur('format-on-save-include', SUGGESTED_FORMAT_ON_SAVE_INCLUDE)

    expect(onUpdateFormatOnSave).toHaveBeenCalledWith(
      expect.objectContaining({ include: [SUGGESTED_FORMAT_ON_SAVE_INCLUDE] })
    )
  })

  it('says nothing extra for an SSH project, which formats through the relay', () => {
    render({ ...baseRepo, connectionId: 'ssh-target-1' })
    expect(container.textContent).not.toContain('runtime host')
  })

  it('says nothing for a WSL worktree, which is a local execution host', () => {
    // Why: WSL repos keep executionHostId 'local' — the formatter runs inside the
    // distro, so the runtime-host notice must not appear for them.
    render({ ...baseRepo, path: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo' })
    expect(container.textContent).not.toContain('runtime host')
  })

  it('warns that a runtime-hosted project is saved unformatted', () => {
    render({ ...baseRepo, executionHostId: 'runtime:env-1' })
    expect(container.textContent).toContain('runtime host')
  })

  it('says nothing about hosts for a local project', () => {
    render()
    expect(container.textContent).not.toContain('runtime host')
  })
})
