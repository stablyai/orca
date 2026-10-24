import { describe, expect, it } from 'vitest'
import {
  initialRemoteFileBrowserHighlight,
  stepRemoteFileBrowserHighlight
} from './remote-file-browser-highlight'

const folder = (name: string) => ({ name, isDirectory: true })
const file = (name: string) => ({ name, isDirectory: false })

describe('initialRemoteFileBrowserHighlight', () => {
  it('starts on the first row', () => {
    expect(initialRemoteFileBrowserHighlight([folder('a'), folder('b')], false)).toBe(0)
  })

  // Why: Enter on a filter that leaves one folder has always opened it, even past files.
  it('starts on the only folder a filter leaves', () => {
    expect(initialRemoteFileBrowserHighlight([file('src.md'), folder('src')], false)).toBe(1)
  })

  it('starts on no row when the list is empty or the typed path is itself the target', () => {
    expect(initialRemoteFileBrowserHighlight([], false)).toBe(-1)
    expect(initialRemoteFileBrowserHighlight([folder('a')], true)).toBe(-1)
  })
})

describe('stepRemoteFileBrowserHighlight', () => {
  it('moves within the list and stops at both ends', () => {
    expect(stepRemoteFileBrowserHighlight(0, 1, 3)).toBe(1)
    expect(stepRemoteFileBrowserHighlight(2, 1, 3)).toBe(2)
    expect(stepRemoteFileBrowserHighlight(0, -1, 3)).toBe(0)
  })

  it('enters the list from no row at the end the key points to', () => {
    expect(stepRemoteFileBrowserHighlight(-1, 1, 3)).toBe(0)
    expect(stepRemoteFileBrowserHighlight(-1, -1, 3)).toBe(2)
  })
})
