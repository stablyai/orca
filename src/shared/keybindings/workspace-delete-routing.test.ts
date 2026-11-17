import { describe, expect, it } from 'vitest'
import {
  getWindowShortcutActionId,
  resolveWindowShortcutAction,
  windowShortcutActionCapturesTerminal
} from './window-shortcut-policy'
import { nativeChatPromptClaimsShortcut } from './text-input-shortcut-policy'

describe.each(['darwin', 'win32', 'linux'] as const)(
  'workspace delete routing on %s',
  (platform) => {
    const chord = {
      code: 'Backspace',
      key: 'Backspace',
      meta: platform === 'darwin',
      control: platform !== 'darwin',
      alt: false,
      shift: true
    }

    it('captures the chord only from a terminal under the Orca-first policy', () => {
      const action = resolveWindowShortcutAction(chord, platform, undefined, {
        context: 'terminal',
        terminalShortcutPolicy: 'orca-first'
      })
      expect(action).toEqual({ type: 'deleteCurrentWorkspace' })
      expect(getWindowShortcutActionId(action!)).toBe('workspace.delete')
      expect(windowShortcutActionCapturesTerminal(action!)).toBe(true)
      expect(
        resolveWindowShortcutAction(chord, platform, undefined, {
          context: 'terminal',
          terminalShortcutPolicy: 'terminal-first'
        })
      ).toBeNull()
    })

    it('leaves app focus to the renderer so the sidebar list keeps its own deletion', () => {
      expect(resolveWindowShortcutAction(chord, platform)).toBeNull()
      expect(
        resolveWindowShortcutAction(chord, platform, undefined, {
          context: 'app',
          terminalShortcutPolicy: 'orca-first'
        })
      ).toBeNull()
    })

    it('honors a rebound or cleared chord inside the terminal', () => {
      const terminal = {
        context: 'terminal' as const,
        terminalShortcutPolicy: 'orca-first' as const
      }
      expect(
        resolveWindowShortcutAction(chord, platform, { 'workspace.delete': [] }, terminal)
      ).toBeNull()
      expect(
        resolveWindowShortcutAction(
          { ...chord, code: 'KeyX', key: 'x', alt: true, shift: false },
          platform,
          { 'workspace.delete': ['Mod+Alt+X'] },
          terminal
        )
      ).toEqual({ type: 'deleteCurrentWorkspace' })
    })

    it('lets the chat prompt pass the delete chord but keep plain line deletion', () => {
      expect(nativeChatPromptClaimsShortcut(chord, platform, 'workspace.delete')).toBe(false)
      expect(nativeChatPromptClaimsShortcut({ ...chord, shift: false }, platform)).toBe(true)
    })
  }
)
