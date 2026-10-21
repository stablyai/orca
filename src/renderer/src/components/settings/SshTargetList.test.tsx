// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { isListOwnSelectAllTarget } from './SshTargetList'

afterEach(() => {
  document.body.innerHTML = ''
})

function mount(html: string): HTMLElement {
  const list = document.createElement('div')
  list.innerHTML = html
  document.body.append(list)
  return list
}

describe('⌘/Ctrl-A on the SSH host list', () => {
  it('selects hosts from a row control inside the list', () => {
    const list = mount('<button id="row">Connect</button>')
    expect(isListOwnSelectAllTarget(list, list.querySelector('#row'))).toBe(true)
  })

  // React bubbles keydown through portals, so a row dialog's event reaches the list handler.
  it('ignores events from portalled dialogs and menus outside the list', () => {
    const list = mount('<button>Connect</button>')
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.innerHTML = '<button id="inside">Restart</button>'
    document.body.append(dialog)
    expect(isListOwnSelectAllTarget(list, dialog.querySelector('#inside'))).toBe(false)
  })

  it('leaves text selection alone in fields, menus and detail text inside the list', () => {
    const list = mount(
      '<input id="field" /><div role="menu"><div id="item">Edit</div></div><pre id="detail">log</pre>'
    )
    for (const id of ['field', 'item', 'detail']) {
      expect(isListOwnSelectAllTarget(list, list.querySelector(`#${id}`))).toBe(false)
    }
  })
})
