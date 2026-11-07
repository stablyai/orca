/**
 * Issues #8533 / #8584 — default keybinding collisions.
 *
 * #8533: darwin Mod+Shift+E → sidebar.explorer.toggle AND tab.newSimulator
 * #8584: all platforms Mod+0 → zoom.reset AND sidebar.focusWorktreeList
 *
 * findKeybindingConflicts() only reports conflicts involving *customized*
 * overrides, so defaults can collide silently. This test asserts raw default
 * binding maps collide.
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts src/shared/repro-8533-8584-shortcut-conflicts.test.ts
 */
import { describe, expect, it } from 'vitest'
import { KEYBINDING_DEFINITIONS, type KeybindingPlatform } from './keybindings'

function defaultOwners(platform: KeybindingPlatform): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const def of KEYBINDING_DEFINITIONS) {
    const binds = def.defaultBindings[platform] ?? []
    for (const binding of binds) {
      const list = map.get(binding) ?? []
      list.push(def.id)
      map.set(binding, list)
    }
  }
  return map
}

describe('issues #8533 and #8584 default shortcut conflicts', () => {
  it('#8533: Mod+Shift+E collides on darwin (explorer toggle vs new simulator)', () => {
    const owners = defaultOwners('darwin').get('Mod+Shift+E') ?? []
    expect(owners).toEqual(expect.arrayContaining(['sidebar.explorer.toggle', 'tab.newSimulator']))
    expect(owners.length).toBeGreaterThanOrEqual(2)

    // Linux/Windows: simulator unbound, so explorer alone owns the chord.
    expect(defaultOwners('linux').get('Mod+Shift+E')).toEqual(['sidebar.explorer.toggle'])
    expect(defaultOwners('win32').get('Mod+Shift+E')).toEqual(['sidebar.explorer.toggle'])
  })

  it('#8584: Mod+0 collides on every platform (zoom.reset vs focus worktree list)', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const owners = defaultOwners(platform).get('Mod+0') ?? []
      expect(owners).toEqual(expect.arrayContaining(['zoom.reset', 'sidebar.focusWorktreeList']))
      expect(owners.length).toBeGreaterThanOrEqual(2)
    }
  })
})
