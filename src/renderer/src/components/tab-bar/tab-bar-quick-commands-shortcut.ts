import { useEffect } from 'react'
import {
  keybindingMatchesAction,
  type KeybindingContext,
  type KeybindingInput
} from '../../../../shared/keybindings'
import {
  ModifierDoubleTapDetector,
  toModifierDoubleTapEvent
} from '../../../../shared/modifier-double-tap-detector'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { TOGGLE_QUICK_COMMANDS_MENU_EVENT } from '@/lib/quick-commands-menu-events'
import { useAppStore } from '@/store'

type UseTabBarQuickCommandsShortcutParams = {
  menuOpen: boolean
  onOpenChange: (next: boolean) => void
}

function targetHasClass(target: EventTarget | null, className: string): boolean {
  const classList = (target as { classList?: { contains?: (value: string) => boolean } } | null)
    ?.classList
  return typeof classList?.contains === 'function' && classList.contains(className)
}

function targetMatchesClosest(target: EventTarget | null, selector: string): boolean {
  const closest = (target as { closest?: (value: string) => unknown } | null)?.closest
  return typeof closest === 'function' && Boolean(closest.call(target, selector))
}

function getQuickCommandsShortcutContext(target: EventTarget | null): KeybindingContext {
  return targetHasClass(target, 'xterm-helper-textarea') ? 'terminal' : 'app'
}

export function useTabBarQuickCommandsShortcut({
  menuOpen,
  onOpenChange
}: UseTabBarQuickCommandsShortcutParams): void {
  const keybindings = useAppStore((s) => s.keybindings)
  const terminalShortcutPolicy = useAppStore(
    (s) => s.settings?.terminalShortcutPolicy ?? 'orca-first'
  )
  const activeView = useAppStore((s) => s.activeView)

  // Why: this hook only runs in the focused tab group's menu component, so the
  // listener naturally scopes to the active group with no extra coordination.
  useEffect(() => {
    if (activeView !== 'terminal') {
      return
    }
    const platform = getShortcutPlatform()
    const doubleTapDetector = new ModifierDoubleTapDetector()
    const matchesShortcut = (input: KeybindingInput, target: EventTarget | null): boolean => {
      const context = getQuickCommandsShortcutContext(target)
      return keybindingMatchesAction('tab.openQuickCommandsMenu', input, platform, keybindings, {
        context,
        terminalShortcutPolicy
      })
    }
    const toggleMenu = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopImmediatePropagation()
      onOpenChange(!menuOpen)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (targetMatchesClosest(e.target, '[data-shortcut-recorder-active]')) {
        doubleTapDetector.reset()
        return
      }
      const detected = doubleTapDetector.process(
        toModifierDoubleTapEvent({
          type: 'keyDown',
          code: e.code,
          key: e.key,
          shift: e.shiftKey,
          control: e.ctrlKey,
          alt: e.altKey,
          meta: e.metaKey,
          isAutoRepeat: e.repeat
        }),
        Date.now()
      )
      if (detected) {
        if (matchesShortcut({ doubleTapModifier: detected.modifier }, e.target)) {
          toggleMenu(e)
        }
        return
      }
      if (e.repeat) {
        return
      }
      if (
        !matchesShortcut(
          {
            key: e.key,
            code: e.code,
            altKey: e.altKey,
            metaKey: e.metaKey,
            ctrlKey: e.ctrlKey,
            shiftKey: e.shiftKey
          },
          e.target
        )
      ) {
        return
      }
      toggleMenu(e)
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (targetMatchesClosest(e.target, '[data-shortcut-recorder-active]')) {
        doubleTapDetector.reset()
        return
      }
      doubleTapDetector.process(
        toModifierDoubleTapEvent({
          type: 'keyUp',
          code: e.code,
          key: e.key,
          shift: e.shiftKey,
          control: e.ctrlKey,
          alt: e.altKey,
          meta: e.metaKey
        }),
        Date.now()
      )
    }
    const onBlur = (): void => doubleTapDetector.reset()
    window.addEventListener('keydown', onKeyDown, { capture: true })
    window.addEventListener('keyup', onKeyUp, { capture: true })
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      window.removeEventListener('keyup', onKeyUp, { capture: true })
      window.removeEventListener('blur', onBlur)
    }
  }, [activeView, keybindings, menuOpen, onOpenChange, terminalShortcutPolicy])

  useEffect(() => {
    if (activeView !== 'terminal') {
      return
    }
    const onToggleQuickCommandsMenu = (): void => {
      onOpenChange(!menuOpen)
    }
    window.addEventListener(TOGGLE_QUICK_COMMANDS_MENU_EVENT, onToggleQuickCommandsMenu)
    return () => {
      window.removeEventListener(TOGGLE_QUICK_COMMANDS_MENU_EVENT, onToggleQuickCommandsMenu)
    }
  }, [activeView, menuOpen, onOpenChange])
}
