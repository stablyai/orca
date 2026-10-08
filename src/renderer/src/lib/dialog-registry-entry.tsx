import { createContext, useContext, useId, useLayoutEffect, useRef } from 'react'
import { useDialogRegistry } from '@/store/dialog-registry'
import {
  selectDialogPhase,
  type AutomaticDialogKind,
  type DialogOrigin,
  type DialogPhase
} from '@/store/dialog-registry-state'

const DialogTokenContext = createContext<string | null>(null)

export function DialogEntryScope({
  token,
  children
}: {
  token: string
  children: React.ReactNode
}): React.JSX.Element {
  return <DialogTokenContext.Provider value={token}>{children}</DialogTokenContext.Provider>
}

// React's effect replay keeps the same token; real disposal settles after the commit finishes.
export function useDialogDisposal(token: string, dispose: (token: string) => void): void {
  const current = useRef<{ token: string } | null>(null)
  useLayoutEffect(() => {
    const lifetime = { token }
    current.current = lifetime
    return () => {
      queueMicrotask(() => {
        if (current.current === lifetime || current.current?.token !== token) {
          dispose(token)
        }
      })
    }
  }, [dispose, token])
}

// Lives inside portaled content, through its exit animation. Nested dialogs get their own token.
export function DialogEntryContent({
  kind = 'dialog',
  origin = 'user',
  children
}: {
  kind?: string
  origin?: Exclude<DialogOrigin, 'automatic'>
  children?: React.ReactNode
}): React.JSX.Element {
  const scopedToken = useContext(DialogTokenContext)
  const ownToken = `dialog:${useId()}`
  const token = scopedToken ?? ownToken
  useLayoutEffect(() => {
    useDialogRegistry.getState().dialogContentMounted(token, kind, origin)
  }, [kind, origin, token])
  useDialogDisposal(token, useDialogRegistry.getState().dialogContentUnmounted)
  return <DialogTokenContext.Provider value={null}>{children}</DialogTokenContext.Provider>
}

export function useAutomaticDialogEntry(
  token: string,
  kind: AutomaticDialogKind,
  request: 'automatic' | 'user' | null
): DialogPhase | null {
  useLayoutEffect(() => {
    const registry = useDialogRegistry.getState()
    if (request === 'automatic') {
      registry.enqueueAutomaticDialog(token, kind)
    } else if (request === 'user') {
      registry.openDialog({ token, kind, origin: 'user' })
    } else {
      registry.closeDialog(token)
    }
  }, [kind, request, token])
  useDialogDisposal(token, useDialogRegistry.getState().closeDialog)
  return useDialogRegistry((s) => selectDialogPhase(s, token))
}
