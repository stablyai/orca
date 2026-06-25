// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import { isRepoHeaderActionTarget } from './project-header-drag'

function createHeader(markup: string): HTMLElement {
  const header = document.createElement('div')
  header.setAttribute('data-repo-header-id', 'repo-1')
  header.innerHTML = markup
  document.body.appendChild(header)
  return header
}

describe('repo header action targets', () => {
  it('ignores explicit project action wrappers', () => {
    const header = createHeader(`
      <span data-repo-header-action="" tabindex="0">
        <span id="icon"></span>
      </span>
    `)

    expect(isRepoHeaderActionTarget(header.querySelector('#icon'), header)).toBe(true)
  })

  it('ignores native nested controls', () => {
    const header = createHeader('<button type="button"><span id="icon"></span></button>')

    expect(isRepoHeaderActionTarget(header.querySelector('#icon'), header)).toBe(true)
  })

  it('does not ignore plain header text or the header itself', () => {
    const header = createHeader('<span id="label">Orca</span>')

    expect(isRepoHeaderActionTarget(header.querySelector('#label'), header)).toBe(false)
    expect(isRepoHeaderActionTarget(header, header)).toBe(false)
  })

  it('ignores the hover collapse affordance', () => {
    const header = createHeader(`
      <div data-repo-header-collapse-affordance="">
        <span id="chevron"></span>
      </div>
    `)

    expect(isRepoHeaderActionTarget(header.querySelector('#chevron'), header)).toBe(true)
  })
})
