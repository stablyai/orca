import { describe, expect, it } from 'vitest'
import {
  buildTabCreateMenuOptions,
  findMatchingTabCreateMenuOptions
} from './tab-create-menu-options'

describe('tab create menu options', () => {
  const defaultOptions = buildTabCreateMenuOptions({
    terminalOnly: false,
    hasNewBrowser: true,
    hasNewMarkdown: true,
    hasOpenMarkdown: true,
    hasSimulator: true,
    simulatorIsGoTo: false
  })

  it('matches mobile emulator aliases to the simulator menu action', () => {
    expect(
      findMatchingTabCreateMenuOptions('mobile emulator', defaultOptions).map(
        (option) => option.kind
      )
    ).toEqual(['new-simulator'])
  })

  it('matches go-to simulator when the workspace already has one', () => {
    const options = buildTabCreateMenuOptions({
      terminalOnly: false,
      hasNewBrowser: true,
      hasNewMarkdown: true,
      hasOpenMarkdown: false,
      hasSimulator: true,
      simulatorIsGoTo: true
    })

    expect(
      findMatchingTabCreateMenuOptions('simulator', options).map((option) => option.kind)
    ).toEqual(['go-to-simulator'])
  })

  it('matches terminal and browser quick actions', () => {
    expect(
      findMatchingTabCreateMenuOptions('new terminal', defaultOptions).map((option) => option.kind)
    ).toEqual(['new-terminal'])
    expect(
      findMatchingTabCreateMenuOptions('browser', defaultOptions).map((option) => option.kind)
    ).toEqual(['new-browser'])
  })

  it('preserves default Windows shell order for tied terminal matches', () => {
    const options = buildTabCreateMenuOptions({
      terminalOnly: false,
      hasNewBrowser: false,
      hasNewMarkdown: false,
      hasOpenMarkdown: false,
      hasSimulator: false,
      simulatorIsGoTo: false,
      windowsShellEntries: [
        { label: 'PowerShell', shell: 'powershell.exe' },
        { label: 'CMD Prompt', shell: 'cmd.exe' }
      ]
    })

    expect(
      findMatchingTabCreateMenuOptions('new terminal', options).map((option) => option.shell)
    ).toEqual(['powershell.exe', 'cmd.exe'])
  })

  it('returns no matches for an empty query', () => {
    expect(findMatchingTabCreateMenuOptions('', defaultOptions)).toEqual([])
    expect(findMatchingTabCreateMenuOptions('   ', defaultOptions)).toEqual([])
  })
})
