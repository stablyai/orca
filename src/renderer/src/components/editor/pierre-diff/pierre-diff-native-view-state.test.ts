// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { buildPierreFileDiff } from './pierre-diff-metadata'
import {
  readPierreNativeSelection,
  restorePierreNativeSelection
} from './pierre-diff-native-view-state'
import type { PierreDiffInstance } from './PierreDiffSurface'

const diff = buildPierreFileDiff({
  path: 'test.txt',
  status: 'modified',
  parseDiffOptions: { ignoreWhitespace: true },
  originalContent: 'old one\nold two\n',
  modifiedContent: 'new one\nnew two\n'
})
const instance = { revealLine: () => false } as unknown as PierreDiffInstance
function host() {
  const host = document.createElement('diffs-container')
  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
  root.innerHTML =
    '<code data-code data-deletions><div data-line="1" data-line-index="0,0" data-line-type="change-deletion">old one\n</div><div data-line="2" data-line-index="1,1" data-line-type="change-deletion">old two\n</div></code>'
  document.body.append(host)
  const nodes = [...root.querySelectorAll('[data-line]')].map((row) => row.firstChild!)
  const range = document.createRange()
  range.setStart(nodes[0], 1)
  range.setEnd(nodes[1], 3)
  const selection = {
    anchorNode: nodes[1],
    anchorOffset: 3,
    focusNode: nodes[0],
    focusOffset: 1,
    rangeCount: 1,
    getRangeAt: () => range,
    setBaseAndExtent: vi.fn()
  }
  Object.defineProperty(root, 'getSelection', { value: () => selection })
  return { host, root, nodes, selection }
}
afterEach(() => document.body.replaceChildren())

it('restores a backward original selection into new token nodes', () => {
  const first = host()
  const saved = readPierreNativeSelection(first.host, diff, true)!
  expect(saved.side).toBe('deletions')
  expect(saved.backward).toBe(true)
  const next = host()
  expect(restorePierreNativeSelection(next.host, diff, saved, instance)).toBe(true)
  expect(next.selection.setBaseAndExtent).toHaveBeenCalledWith(next.nodes[1], 3, next.nodes[0], 1)
})

it('does not restore offsets over changed original content', () => {
  const view = host()
  const saved = readPierreNativeSelection(view.host, diff, false)!
  expect(
    restorePierreNativeSelection(
      view.host,
      { ...diff, deletionLines: ['external change\n'] },
      saved,
      instance
    )
  ).toBe(true)
  expect(view.selection.setBaseAndExtent).not.toHaveBeenCalled()
})

it('waits for both virtualized endpoints rather than selecting a partial range', () => {
  const view = host()
  const saved = readPierreNativeSelection(view.host, diff, false)!
  view.nodes[1].parentElement!.remove()
  expect(restorePierreNativeSelection(view.host, diff, saved, instance)).toBe(false)
  expect(view.selection.setBaseAndExtent).not.toHaveBeenCalled()
})
