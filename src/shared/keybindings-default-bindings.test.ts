// Per-platform default bindings and action metadata in the registry.
import { describe, expect, it } from 'vitest'
import {
  agentTabActionId,
  getKeybindingDefinition,
  findKeybindingConflicts,
  formatKeybindingList,
  getEffectiveKeybindingsForAction,
  keybindingFromInput,
  LEGACY_TAB_SWITCH_BINDINGS,
  keybindingMatchesAction
} from './keybindings'
import type { KeybindingActionId } from './keybindings'
import { ALL_TUI_AGENTS } from './tui-agent-display-names'

describe('keybindings', () => {
  it('defines a default shortcut for opening markdown notes', () => {
    expect(getEffectiveKeybindingsForAction('tab.openMarkdown', 'darwin')).toEqual(['Mod+Shift+O'])
    expect(formatKeybindingList(['Mod+Shift+O'], 'darwin')).toBe('⌘⇧O')
  })

  it.each(['darwin', 'linux', 'win32'] as const)(
    'binds editor command palette to F1 on %s',
    (platform) => {
      expect(getEffectiveKeybindingsForAction('editor.commandPalette', platform)).toEqual(['F1'])
      expect(formatKeybindingList(['F1'], platform)).toBe('F1')
      expect(
        keybindingMatchesAction(
          'editor.commandPalette',
          {
            key: 'F1',
            code: 'F1',
            meta: false,
            control: false,
            alt: false,
            shift: false
          },
          platform
        )
      ).toBe(true)
    }
  )

  it.each(['darwin', 'linux', 'win32'] as const)(
    'binds editor word wrap to Alt+Z on %s',
    (platform) => {
      expect(getEffectiveKeybindingsForAction('editor.toggleWordWrap', platform)).toEqual(['Alt+Z'])
    }
  )

  it('matches macOS Option+Z through its composed key', () => {
    expect(
      keybindingMatchesAction(
        'editor.toggleWordWrap',
        {
          key: 'Ω',
          code: 'KeyZ',
          meta: false,
          control: false,
          alt: true,
          shift: false
        },
        'darwin'
      )
    ).toBe(true)
  })

  it('defines a default shortcut for adding an editor review note', () => {
    expect(getEffectiveKeybindingsForAction('editor.addReviewNote', 'darwin')).toEqual([
      'Mod+Shift+A'
    ])
    expect(getEffectiveKeybindingsForAction('editor.addReviewNote', 'linux')).toEqual([
      'Mod+Shift+A'
    ])
    expect(getEffectiveKeybindingsForAction('editor.addReviewNote', 'win32')).toEqual([
      'Mod+Shift+A'
    ])
    expect(formatKeybindingList(['Mod+Shift+A'], 'darwin')).toBe('⌘⇧A')
    expect(formatKeybindingList(['Mod+Shift+A'], 'linux')).toBe('Ctrl+Shift+A')

    const macChord = {
      key: 'a',
      code: 'KeyA',
      meta: true,
      control: false,
      alt: false,
      shift: true
    }
    const ctrlChord = { ...macChord, meta: false, control: true }
    expect(keybindingMatchesAction('editor.addReviewNote', macChord, 'darwin')).toBe(true)
    expect(keybindingMatchesAction('editor.addReviewNote', ctrlChord, 'linux')).toBe(true)
    expect(keybindingMatchesAction('editor.addReviewNote', ctrlChord, 'win32')).toBe(true)

    const oldCtrlAltChord = {
      key: 'n',
      code: 'KeyN',
      meta: false,
      control: true,
      alt: true,
      shift: false
    }
    expect(keybindingMatchesAction('editor.addReviewNote', oldCtrlAltChord, 'linux')).toBe(false)
    expect(keybindingMatchesAction('editor.addReviewNote', oldCtrlAltChord, 'win32')).toBe(false)
  })

  it('maps browser Find to Command on macOS and Control elsewhere', () => {
    const commandF = {
      key: 'f',
      code: 'KeyF',
      meta: true,
      control: false,
      alt: false,
      shift: false
    }
    const controlF = { ...commandF, meta: false, control: true }

    expect(keybindingMatchesAction('browser.find', commandF, 'darwin')).toBe(true)
    expect(keybindingMatchesAction('browser.find', controlF, 'darwin')).toBe(false)
    expect(keybindingMatchesAction('browser.find', controlF, 'linux')).toBe(true)
    expect(keybindingMatchesAction('browser.find', controlF, 'win32')).toBe(true)
    expect(keybindingMatchesAction('browser.find', commandF, 'linux')).toBe(false)
    expect(keybindingMatchesAction('browser.find', commandF, 'win32')).toBe(false)
  })

  it('defines platform-native replace-in-editor shortcuts', () => {
    expect(getEffectiveKeybindingsForAction('editor.replace', 'darwin')).toEqual(['Mod+Alt+F'])
    expect(getEffectiveKeybindingsForAction('editor.replace', 'linux')).toEqual(['Mod+H'])
    expect(getEffectiveKeybindingsForAction('editor.replace', 'win32')).toEqual(['Mod+H'])
    expect(formatKeybindingList(['Mod+Alt+F'], 'darwin')).toBe('⌘⌥F')
    expect(formatKeybindingList(['Mod+H'], 'linux')).toBe('Ctrl+H')
  })

  it('defines macOS-only rename shortcuts that stay conflict-free', () => {
    expect(getEffectiveKeybindingsForAction('tab.rename', 'darwin')).toEqual(['Mod+R'])
    expect(getEffectiveKeybindingsForAction('tab.rename', 'linux')).toEqual([])
    expect(getEffectiveKeybindingsForAction('tab.rename', 'win32')).toEqual([])
    expect(getEffectiveKeybindingsForAction('workspace.rename', 'darwin')).toEqual(['Mod+Alt+R'])
    expect(getEffectiveKeybindingsForAction('workspace.rename', 'linux')).toEqual([])
    expect(formatKeybindingList(['Mod+Alt+R'], 'darwin')).toBe('⌘⌥R')
    expect(getKeybindingDefinition('tab.rename')?.searchKeywords).not.toContain('set title')
    expect(
      keybindingMatchesAction(
        'tab.rename',
        {
          key: 'r',
          code: 'KeyR',
          meta: true,
          control: false,
          alt: false,
          shift: false
        },
        'darwin'
      )
    ).toBe(true)
    expect(
      keybindingMatchesAction(
        'tab.rename',
        {
          key: 'r',
          code: 'KeyR',
          meta: false,
          control: true,
          alt: false,
          shift: false
        },
        'linux'
      )
    ).toBe(false)
    expect(
      keybindingMatchesAction(
        'tab.rename',
        {
          key: 'r',
          code: 'KeyR',
          meta: true,
          control: false,
          alt: false,
          shift: false
        },
        'darwin',
        undefined,
        { context: 'terminal', terminalShortcutPolicy: 'terminal-first' }
      )
    ).toBe(false)

    // Why: tab.rename (Mod+R) intentionally shares its binding with
    // browser.reload, but the two live in different scopes (tabs vs browser),
    // so customizing tab.rename to its default must not flag a conflict.
    expect(findKeybindingConflicts('darwin', { 'tab.rename': ['Mod+R'] })).toEqual([])
    // Why: tab/workspace rename share the same active workspace keydown path,
    // so Settings must reject user overrides that make one shadow the other.
    expect(findKeybindingConflicts('darwin', { 'workspace.rename': ['Mod+R'] })).toEqual([
      {
        binding: 'Mod+R',
        actionIds: ['workspace.rename', 'tab.rename']
      }
    ])
    expect(findKeybindingConflicts('darwin', { 'tab.rename': ['Mod+Alt+R'] })).toEqual([
      {
        binding: 'Mod+Alt+R',
        actionIds: ['workspace.rename', 'tab.rename']
      }
    ])
  })

  it('defaults tab-switch chords to the swapped convention for fresh installs', () => {
    // New users get the widespread mapping: Shift+bracket cycles all tabs,
    // Alt+bracket cycles within the active type.
    expect(getEffectiveKeybindingsForAction('tab.nextAllTypes', 'darwin')).toEqual([
      'Mod+Shift+BracketRight'
    ])
    expect(getEffectiveKeybindingsForAction('tab.previousAllTypes', 'darwin')).toEqual([
      'Mod+Shift+BracketLeft'
    ])
    expect(getEffectiveKeybindingsForAction('tab.nextSameType', 'darwin')).toEqual([
      'Mod+Alt+BracketRight'
    ])
    expect(getEffectiveKeybindingsForAction('tab.previousSameType', 'darwin')).toEqual([
      'Mod+Alt+BracketLeft'
    ])
  })

  it('pins the pre-swap chords via LEGACY_TAB_SWITCH_BINDINGS for upgrading installs', () => {
    // These are what the seed migration writes so pre-existing users keep the
    // shortcuts they learned; overriding an action with its legacy value must
    // reproduce the old effective binding.
    expect(LEGACY_TAB_SWITCH_BINDINGS).toEqual({
      'tab.nextSameType': ['Mod+Shift+BracketRight'],
      'tab.previousSameType': ['Mod+Shift+BracketLeft'],
      'tab.nextAllTypes': ['Mod+Alt+BracketRight'],
      'tab.previousAllTypes': ['Mod+Alt+BracketLeft']
    })
    for (const [actionId, bindings] of Object.entries(LEGACY_TAB_SWITCH_BINDINGS)) {
      expect(
        getEffectiveKeybindingsForAction(actionId as KeybindingActionId, 'darwin', {
          [actionId]: bindings
        })
      ).toEqual(bindings)
    }
  })

  it('defines browser history shortcuts for Logitech side-button remaps', () => {
    expect(getEffectiveKeybindingsForAction('browser.back', 'darwin')).toEqual(['Mod+BracketLeft'])
    expect(getEffectiveKeybindingsForAction('browser.forward', 'darwin')).toEqual([
      'Mod+BracketRight'
    ])
    expect(getEffectiveKeybindingsForAction('browser.back', 'linux')).toEqual(['Alt+ArrowLeft'])
    expect(getEffectiveKeybindingsForAction('browser.forward', 'win32')).toEqual(['Alt+ArrowRight'])
    expect(
      keybindingMatchesAction(
        'browser.back',
        {
          key: '[',
          code: 'BracketLeft',
          meta: true,
          control: false,
          alt: false,
          shift: false
        },
        'darwin'
      )
    ).toBe(true)
    expect(
      keybindingMatchesAction(
        'browser.forward',
        {
          key: 'ArrowRight',
          code: 'ArrowRight',
          meta: false,
          control: false,
          alt: true,
          shift: false
        },
        'linux'
      )
    ).toBe(true)
  })

  it('binds close-all editor tabs to Mod+Alt+W beside tab.close', () => {
    expect(getEffectiveKeybindingsForAction('tab.closeAll', 'darwin')).toEqual(['Mod+Alt+W'])
    expect(getEffectiveKeybindingsForAction('tab.closeAll', 'linux')).toEqual(['Mod+Alt+W'])
    expect(getEffectiveKeybindingsForAction('tab.closeAll', 'win32')).toEqual(['Mod+Alt+W'])
    expect(formatKeybindingList(['Mod+Alt+W'], 'darwin')).toBe('⌘⌥W')
    expect(formatKeybindingList(['Mod+Alt+W'], 'linux')).toBe('Ctrl+Alt+W')

    // Why: macOS Option+W composes to a glyph (∑), so the chord must resolve
    // through the physical-code fallback rather than the logical key.
    const macComposedCloseAll = {
      key: '∑',
      code: 'KeyW',
      meta: true,
      control: false,
      alt: true,
      shift: false
    }
    expect(keybindingMatchesAction('tab.closeAll', macComposedCloseAll, 'darwin')).toBe(true)
    const linuxCloseAll = {
      key: 'w',
      code: 'KeyW',
      meta: false,
      control: true,
      alt: true,
      shift: false
    }
    expect(keybindingMatchesAction('tab.closeAll', linuxCloseAll, 'linux')).toBe(true)
    expect(
      keybindingMatchesAction('tab.closeAll', linuxCloseAll, 'linux', undefined, {
        context: 'terminal',
        terminalShortcutPolicy: 'orca-first'
      })
    ).toBe(true)
    // Why: close-all is a workspace tab command, so terminal-first mode should
    // keep passing the chord through to shells and TUIs.
    expect(
      keybindingMatchesAction('tab.closeAll', linuxCloseAll, 'linux', undefined, {
        context: 'terminal',
        terminalShortcutPolicy: 'terminal-first'
      })
    ).toBe(false)

    // Why: Mod+Alt+W and Mod+W are neighbors; the extra Alt must keep the two
    // actions from firing on each other's chord.
    const macCloseActive = {
      key: 'w',
      code: 'KeyW',
      meta: true,
      control: false,
      alt: false,
      shift: false
    }
    expect(keybindingMatchesAction('tab.close', macComposedCloseAll, 'darwin')).toBe(false)
    expect(keybindingMatchesAction('tab.closeAll', macCloseActive, 'darwin')).toBe(false)

    // Stays in the Tabs group/scope so Settings → Shortcuts lists it for rebinding.
    const definition = getKeybindingDefinition('tab.closeAll')
    expect(definition?.group).toBe('Tabs')
    expect(definition?.scope).toBe('tabs')

    // Why: both live in the Tabs scope, so rebinding closeAll onto Mod+W must
    // surface as a conflict with tab.close in Settings.
    expect(findKeybindingConflicts('darwin', { 'tab.closeAll': ['Mod+W'] })).toContainEqual({
      binding: 'Mod+W',
      actionIds: expect.arrayContaining(['tab.close', 'tab.closeAll'])
    })
  })

  it('defines floating workspace panel action metadata', () => {
    const actionIds = [
      'floatingWorkspace.maximize' as KeybindingActionId,
      'floatingWorkspace.minimize' as KeybindingActionId
    ] as const

    for (const actionId of actionIds) {
      expect(getKeybindingDefinition(actionId), actionId).toMatchObject({ id: actionId })
    }
  })

  it('assigns the floating workspace maximize default only on macOS', () => {
    const maximizeAction = 'floatingWorkspace.maximize' as KeybindingActionId

    expect(getEffectiveKeybindingsForAction(maximizeAction, 'darwin')).toEqual(['Mod+Alt+Shift+A'])
    expect(getEffectiveKeybindingsForAction(maximizeAction, 'linux')).toEqual([])
    expect(getEffectiveKeybindingsForAction(maximizeAction, 'win32')).toEqual([])
  })

  it('captures and round-trips the macOS Option-composed maximize chord', () => {
    const maximizeAction = 'floatingWorkspace.maximize' as KeybindingActionId

    // Why: macOS Option+A composes to a glyph (å), so capture must resolve the
    // chord through the physical-code fallback rather than the composed key,
    // matching the matcher so a user override round-trips to the same binding.
    const macComposedMaximize = {
      key: 'å',
      code: 'KeyA',
      meta: true,
      control: false,
      alt: true,
      shift: true
    }
    expect(keybindingFromInput(macComposedMaximize, 'darwin')).toEqual({
      ok: true,
      value: 'Mod+Alt+Shift+A'
    })
    expect(keybindingMatchesAction(maximizeAction, macComposedMaximize, 'darwin')).toBe(true)
    // The captured override formats back to the same effective shortcut.
    expect(
      getEffectiveKeybindingsForAction(maximizeAction, 'darwin', {
        [maximizeAction]: ['Mod+Alt+Shift+A']
      })
    ).toEqual(['Mod+Alt+Shift+A'])
    expect(formatKeybindingList(['Mod+Alt+Shift+A'], 'darwin')).toBe('⌘⌥⇧A')
  })

  it('defines a macOS-only default for the new agent tab shortcut', () => {
    expect(getEffectiveKeybindingsForAction('tab.newAgent', 'darwin')).toEqual(['Mod+Alt+T'])
    expect(getEffectiveKeybindingsForAction('tab.newAgent', 'linux')).toEqual([])
    expect(getEffectiveKeybindingsForAction('tab.newAgent', 'win32')).toEqual([])
    expect(
      keybindingMatchesAction(
        'tab.newAgent',
        { key: 't', code: 'KeyT', meta: true, control: false, alt: true, shift: false },
        'darwin'
      )
    ).toBe(true)
  })

  // Why: #8533 — both previously defaulted to Mod+Shift+E on darwin; emulator won.
  it('keeps explorer on Mod+Shift+E and gives the mobile emulator a non-colliding macOS default', () => {
    expect(getEffectiveKeybindingsForAction('sidebar.explorer.toggle', 'darwin')).toEqual([
      'Mod+Shift+E'
    ])
    expect(getEffectiveKeybindingsForAction('tab.newSimulator', 'darwin')).toEqual([
      'Mod+Alt+Shift+E'
    ])
    expect(getEffectiveKeybindingsForAction('tab.newSimulator', 'linux')).toEqual([])
    expect(getEffectiveKeybindingsForAction('tab.newSimulator', 'win32')).toEqual([])
    expect(formatKeybindingList(['Mod+Alt+Shift+E'], 'darwin')).toBe('⌘⌥⇧E')

    expect(
      keybindingMatchesAction(
        'sidebar.explorer.toggle',
        { key: 'e', code: 'KeyE', meta: true, control: false, alt: false, shift: true },
        'darwin'
      )
    ).toBe(true)
    expect(
      keybindingMatchesAction(
        'tab.newSimulator',
        { key: 'e', code: 'KeyE', meta: true, control: false, alt: false, shift: true },
        'darwin'
      )
    ).toBe(false)
    expect(
      keybindingMatchesAction(
        'tab.newSimulator',
        { key: 'e', code: 'KeyE', meta: true, control: false, alt: true, shift: true },
        'darwin'
      )
    ).toBe(true)
  })

  it('defines an unassigned per-agent tab action for every TUI agent', () => {
    for (const agent of ALL_TUI_AGENTS) {
      const actionId = agentTabActionId(agent)
      const definition = getKeybindingDefinition(actionId)
      expect(definition, actionId).toBeDefined()
      expect(definition?.group).toBe('Agents')
      expect(definition?.scope).toBe('tabs')
      expect(getEffectiveKeybindingsForAction(actionId, 'darwin')).toEqual([])
    }
  })

  it('matches per-agent tab actions only through user overrides', () => {
    const binding = { key: 'k', code: 'KeyK', meta: true, control: false, alt: true, shift: true }
    expect(keybindingMatchesAction(agentTabActionId('claude'), binding, 'darwin')).toBe(false)
    expect(
      keybindingMatchesAction(agentTabActionId('claude'), binding, 'darwin', {
        'tab.newAgent.claude': ['Mod+Alt+Shift+K']
      })
    ).toBe(true)
  })
})
