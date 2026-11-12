import { useCallback, useState } from 'react'
import type React from 'react'
import {
  keybindingMatchesAction,
  type KeybindingOverrides
} from '../../../../../../shared/keybindings'
import {
  ModifierDoubleTapDetector,
  toModifierDoubleTapEvent
} from '../../../../../../shared/modifier-double-tap-detector'
import { textInputOwnsComposition } from '../../../../../../shared/text-input-shortcut-policy'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import {
  runWorktreeContextMenuDeleteIntent,
  type WorktreeContextMenuDeleteIntent
} from '../../workspace-actions/context-menu/worktree-context-menu-delete-intent'

export function useSidebarWorkspaceDeleteKeyboard({
  keybindings,
  resolveDeleteIntent,
  dropPreview
}: {
  keybindings: KeybindingOverrides
  resolveDeleteIntent?: () => WorktreeContextMenuDeleteIntent | null
  dropPreview: () => void
}) {
  const [detector] = useState(() => new ModifierDoubleTapDetector())
  const resetDeleteGesture = useCallback(() => detector.reset(), [detector])
  const process = useCallback(
    (e: React.KeyboardEvent, type: 'keyDown' | 'keyUp') =>
      detector.process(
        toModifierDoubleTapEvent({
          type,
          code: e.code,
          key: e.key,
          shift: e.shiftKey,
          control: e.ctrlKey,
          alt: e.altKey,
          meta: e.metaKey,
          isAutoRepeat: e.repeat
        }),
        Date.now()
      ),
    [detector]
  )
  const handleDeleteKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      const detected = process(e, 'keyDown')
      if (
        !keybindingMatchesAction(
          'workspace.delete',
          detected ? { doubleTapModifier: detected.modifier } : e,
          getShortcutPlatform(),
          keybindings
        )
      ) {
        return false
      }
      const intent = resolveDeleteIntent?.()
      if (intent) {
        e.preventDefault()
        e.stopPropagation()
        if (!e.repeat) {
          dropPreview()
          runWorktreeContextMenuDeleteIntent(intent)
        }
      }
      return true
    },
    [process, keybindings, resolveDeleteIntent, dropPreview]
  )
  const handleContainerKeyUp = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.target !== e.currentTarget || textInputOwnsComposition(e)) {
        resetDeleteGesture()
        return
      }
      process(e, 'keyUp')
    },
    [process, resetDeleteGesture]
  )
  return { handleDeleteKeyDown, handleContainerKeyUp, resetDeleteGesture }
}
