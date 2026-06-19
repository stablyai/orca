// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import {
  isComposerFieldToFieldFocus,
  WORKSPACE_COMPOSER_ROOT_SELECTOR
} from './smart-workspace-source-popover-focus'

describe('isComposerFieldToFieldFocus', () => {
  it('returns true when focus moves between fields inside the composer root', () => {
    document.body.innerHTML = `
      <div data-workspace-composer-root="true">
        <button id="project" type="button">Project</button>
        <input id="name" type="text" />
      </div>
    `
    const nameInput = document.getElementById('name') as HTMLInputElement
    const projectButton = document.getElementById('project') as HTMLButtonElement

    expect(
      isComposerFieldToFieldFocus({
        currentTarget: nameInput,
        relatedTarget: projectButton
      })
    ).toBe(true)
  })

  it('returns false for dialog autofocus where focus comes from outside the composer', () => {
    document.body.innerHTML = `
      <button id="close" type="button">Close</button>
      <div data-workspace-composer-root="true">
        <input id="name" type="text" />
      </div>
    `
    const nameInput = document.getElementById('name') as HTMLInputElement
    const closeButton = document.getElementById('close') as HTMLButtonElement

    expect(
      isComposerFieldToFieldFocus({
        currentTarget: nameInput,
        relatedTarget: closeButton
      })
    ).toBe(false)
  })

  it('returns false when relatedTarget is missing', () => {
    document.body.innerHTML = `
      <div data-workspace-composer-root="true">
        <input id="name" type="text" />
      </div>
    `
    const nameInput = document.getElementById('name') as HTMLInputElement

    expect(
      isComposerFieldToFieldFocus({
        currentTarget: nameInput,
        relatedTarget: null
      })
    ).toBe(false)
  })

  it('exports the composer root selector used by the card', () => {
    expect(WORKSPACE_COMPOSER_ROOT_SELECTOR).toBe('[data-workspace-composer-root="true"]')
  })
})
