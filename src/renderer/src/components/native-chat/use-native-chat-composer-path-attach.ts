import { useEffect, useLayoutEffect, useRef } from 'react'
import type { NativeChatResolvedPathOptions } from './native-chat-resolved-path-ownership'
import {
  markNativeChatComposerPathAttachFocused,
  registerNativeChatComposerPathAttach
} from './native-chat-composer-path-attach'

export function useNativeChatComposerPathAttach(
  scopeKey: string,
  attachResolvedPaths: (
    paths: string[],
    connectionId?: string | null,
    options?: NativeChatResolvedPathOptions
  ) => void,
  disabled: boolean
): void {
  const attacherRef = useRef({ attachResolvedPaths, disabled })
  useLayoutEffect(() => {
    attacherRef.current = { attachResolvedPaths, disabled }
  }, [attachResolvedPaths, disabled])

  // Caret moves recreate attachResolvedPaths; register against the pane id only
  // so cleanup cannot drop last-focused between two ready composers.
  useEffect(
    () =>
      registerNativeChatComposerPathAttach(scopeKey, {
        attachResolvedPaths: (paths, connectionId, options) => {
          attacherRef.current.attachResolvedPaths(paths, connectionId, options)
        },
        get disabled() {
          return attacherRef.current.disabled
        }
      }),
    [scopeKey]
  )

  useEffect(() => {
    const onFocusIn = (event: FocusEvent): void => {
      const target = event.target
      if (target instanceof Node && composerSurfaceContains(scopeKey, target)) {
        markNativeChatComposerPathAttachFocused(scopeKey)
      }
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [scopeKey])
}

function composerSurfaceContains(scopeKey: string, node: Node): boolean {
  for (const surface of document.querySelectorAll('[data-composer-scope-key]')) {
    if (surface.getAttribute('data-composer-scope-key') === scopeKey && surface.contains(node)) {
      return true
    }
  }
  return false
}
