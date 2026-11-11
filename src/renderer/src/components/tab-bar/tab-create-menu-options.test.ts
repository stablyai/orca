import { describe, expect, it } from 'vitest'
import {
  buildTabCreateMenuOptions,
  findMatchingTabCreateMenuOptions
} from './tab-create-menu-options'

const t = (_key: string, fallback: string): string => fallback
const base = {
  hasNewBrowser: true,
  hasNewMarkdown: true,
  hasOpenMarkdown: false,
  hasSimulator: false,
  simulatorIsGoTo: false,
  terminalOnly: false
}

describe('+ menu remote desktop entry', () => {
  it('is offered only for Orca Cloud workspaces, after the browser', () => {
    expect(buildTabCreateMenuOptions(base, t).map((o) => o.kind)).not.toContain(
      'open-remote-desktop'
    )
    const options = buildTabCreateMenuOptions({ ...base, remoteDesktop: { isGoTo: false } }, t)
    expect(options.map((o) => o.kind)).toEqual([
      'new-terminal',
      'new-browser',
      'open-remote-desktop',
      'new-markdown'
    ])
    expect(options[2].label).toBe('Open Remote Desktop')
  })

  it('goes to the open desktop tab instead of a second one, and is found by "vnc"', () => {
    const options = buildTabCreateMenuOptions({ ...base, remoteDesktop: { isGoTo: true } }, t)
    expect(options.find((o) => o.kind === 'open-remote-desktop')?.label).toBe(
      'Go to Remote Desktop'
    )
    expect(findMatchingTabCreateMenuOptions('vnc', options)[0]?.kind).toBe('open-remote-desktop')
  })
})
