// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import { isProjectGroupHeaderActionTarget } from './project-group-header-drag'

function createHeader(markup: string): HTMLElement {
  const header = document.createElement('div')
  header.setAttribute('data-project-group-header-id', 'group-1')
  header.innerHTML = markup
  document.body.appendChild(header)
  return header
}

describe('project group header action targets', () => {
  it('ignores explicit project action wrappers', () => {
    const header = createHeader(`
      <span data-repo-header-action="" tabindex="0">
        <span id="icon"></span>
      </span>
    `)

    expect(isProjectGroupHeaderActionTarget(header.querySelector('#icon'), header)).toBe(true)
  })

  it('ignores the project header actions overlay (including gaps between icons)', () => {
    const header = createHeader(`
      <div data-repo-header-actions="">
        <button type="button" data-repo-header-action=""><span id="icon"></span></button>
      </div>
    `)

    expect(
      isProjectGroupHeaderActionTarget(header.querySelector('[data-repo-header-actions]'), header)
    ).toBe(true)
    expect(isProjectGroupHeaderActionTarget(header.querySelector('#icon'), header)).toBe(true)
  })

  it('ignores the hover collapse affordance', () => {
    const header = createHeader(`
      <div data-repo-header-collapse-affordance="">
        <span id="chevron"></span>
      </div>
    `)

    expect(isProjectGroupHeaderActionTarget(header.querySelector('#chevron'), header)).toBe(true)
  })

  it('does not ignore plain header text or the header itself', () => {
    const header = createHeader('<span id="label">Group</span>')

    expect(isProjectGroupHeaderActionTarget(header.querySelector('#label'), header)).toBe(false)
    expect(isProjectGroupHeaderActionTarget(header, header)).toBe(false)
  })
})
