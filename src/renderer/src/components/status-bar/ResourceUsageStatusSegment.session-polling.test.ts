import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SOURCE_PATH = resolve(__dirname, 'use-resource-usage-status-controller.ts')
const INVENTORY_HOOK_PATH = resolve(__dirname, 'use-resource-session-inventory.ts')
const SEGMENT_PATH = resolve(__dirname, 'ResourceUsageStatusSegment.tsx')

describe('ResourceUsageStatusSegment session inventory', () => {
  it('does not poll global terminal sessions while the popover is closed', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8')
    const inventoryHookSource = readFileSync(INVENTORY_HOOK_PATH, 'utf8')

    expect(source).not.toContain('installWindowVisibilityInterval')
    expect(source).not.toContain('SESSIONS_POLL_MS')
    expect(inventoryHookSource).not.toContain('setInterval')
    // Why: every seed/action/lifecycle refresh shares one guarded inventory
    // read, and the closed path never installs a polling interval.
    expect(inventoryHookSource.match(/window\.api\.pty\.listSessions\(\)/g) ?? []).toHaveLength(1)
  })

  it('seeds the closed badge from daemon inventory instead of wake-hint bound PTYs', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8')
    const inventoryHookSource = readFileSync(INVENTORY_HOOK_PATH, 'utf8')

    expect(source).toContain('useResourceSessionInventory')
    expect(source).toContain('sessionInventory.count')
    expect(inventoryHookSource).toContain('window.api.pty.onSpawned')
    expect(inventoryHookSource).toContain('window.api.pty.onExit')
  })

  it('hides local daemon recovery from a remote host view', () => {
    const source = readFileSync(SEGMENT_PATH, 'utf8')

    expect(source).toMatch(/!viewingRemoteHost\s*&&\s*daemonUnreachable/)
    expect(source).toMatch(/!viewingRemoteHost\s*&&\s*!daemonUnreachable\s*&&\s*sessionsOnlyError/)
  })

  it('continues polling the local badge while a remote host is selected', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8')
    const pollBlock = source.slice(
      source.indexOf('// Poll memory only while the popover is open.'),
      source.indexOf(
        '  useEffect(() => {\n    if (!open) {\n      clearSessionsError()',
        source.indexOf('// Poll memory only while the popover is open.')
      )
    )

    expect(pollBlock).toContain('void fetchSnapshot(activeHostId)')
    expect(pollBlock).toContain('void fetchSnapshot(LOCAL_EXECUTION_HOST_ID)')
  })
})
