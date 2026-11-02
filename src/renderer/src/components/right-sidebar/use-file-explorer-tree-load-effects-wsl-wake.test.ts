// @vitest-environment happy-dom
import { read, owner, listing, settle } from './file-explorer-reveal-test-fixtures'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { resetWorkspaceSwitchUserActsForTests } from '@/lib/workspace-switch-user-act'
import { useVisibleTree } from './file-explorer-lifecycle-test-support'

const ROOT = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
const SRC = `${ROOT}\\src`
const DOCS = `${ROOT}\\docs`
function render(expanded: Set<string>) {
  const reset = vi.fn(),
    filter = vi.fn()
  useAppStore.setState({ expandedDirs: { wt: expanded } })
  read.mockResolvedValueOnce({
    ...listing(),
    entries: ['src', 'docs'].map((name) => ({ name, isDirectory: true, isSymlink: false }))
  })
  return renderHook(() =>
    useVisibleTree({ visible: true, id: 'wt', root: ROOT, scope: ROOT }, reset, filter, owner)
  )
}
const wokeFor = (dirPath: string): boolean =>
  read.mock.calls.some(([, , path, options]) => path === dirPath && options?.wakeWslDistro === true)
beforeEach(() => resetWorkspaceSwitchUserActsForTests())
describe('file explorer folder loads wake a stopped WSL distro only for a folder the user expands (E9)', () => {
  it('a mount re-reading folders that were already open wakes nothing', async () => {
    render(new Set([SRC]))
    await settle()
    expect(read.mock.calls.filter((call) => call[2] === SRC)).toHaveLength(1)
    expect(wokeFor(SRC)).toBe(false)
    expect(read.mock.calls.every((call) => !call[3]?.wakeWslDistro)).toBe(true)
  })
  it('a folder expanded after the mount wakes; the ones already open do not', async () => {
    const view = render(new Set([SRC]))
    await settle()
    read.mockClear()
    act(() => view.result.current.toggleDir('wt', DOCS))
    await settle()
    expect(wokeFor(DOCS)).toBe(true)
    expect(wokeFor(SRC)).toBe(false)
    expect(read.mock.calls.filter((call) => call[2] === DOCS)).toHaveLength(1)
  })
  it('a remount after host loss, with the same folders open, wakes nothing', async () => {
    const first = render(new Set([SRC]))
    await settle()
    act(() => first.result.current.toggleDir('wt', DOCS))
    await settle()
    first.unmount()
    read.mockClear()
    render(new Set([SRC, DOCS]))
    await settle()
    expect(read.mock.calls.filter((call) => call[2] === SRC)).toHaveLength(1)
    expect(read.mock.calls.filter((call) => call[2] === DOCS)).toHaveLength(1)
    expect(wokeFor(SRC)).toBe(false)
    expect(wokeFor(DOCS)).toBe(false)
    expect(read.mock.calls.every((call) => !call[3]?.wakeWslDistro)).toBe(true)
  })
})
