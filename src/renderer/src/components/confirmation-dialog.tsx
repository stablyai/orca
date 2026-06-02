import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useAppStore } from '@/store'

type ConfirmationDialogOptions = {
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  confirmVariant?: 'default' | 'destructive'
}

type ConfirmationDialogRequest = {
  id: number
  options: ConfirmationDialogOptions
  resolve: (confirmed: boolean) => void
}

type ConfirmationDialogContextValue = (options: ConfirmationDialogOptions) => Promise<boolean>

const ConfirmationDialogContext = createContext<ConfirmationDialogContextValue | null>(null)

export function ConfirmationDialogProvider({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const nextIdRef = useRef(0)
  const [queue, setQueue] = useState<ConfirmationDialogRequest[]>([])
  const activeRequest = queue[0] ?? null
  const activeRequestRef = useRef<ConfirmationDialogRequest | null>(activeRequest)
  const setContextualToursBlockingSurfaceVisible = useAppStore(
    (s) => s.setContextualToursBlockingSurfaceVisible
  )
  const lastDisplayedRequestRef = useRef<ConfirmationDialogRequest | null>(activeRequest)
  activeRequestRef.current = activeRequest
  if (activeRequest) {
    lastDisplayedRequestRef.current = activeRequest
  }
  // Why: Radix keeps dialog content mounted while closing; keep labels stable without a post-render Effect.
  const displayedRequest = activeRequest ?? lastDisplayedRequestRef.current

  useEffect(() => {
    // Why: this provider's dialog is not represented by activeModal. Block
    // contextual tours so they cannot appear behind confirmation prompts.
    setContextualToursBlockingSurfaceVisible(activeRequest !== null)
    return () => setContextualToursBlockingSurfaceVisible(false)
  }, [activeRequest, setContextualToursBlockingSurfaceVisible])

  const confirm = useCallback<ConfirmationDialogContextValue>((options) => {
    return new Promise((resolve) => {
      const request: ConfirmationDialogRequest = {
        id: nextIdRef.current,
        options,
        resolve
      }
      nextIdRef.current += 1
      setQueue((currentQueue) => [...currentQueue, request])
    })
  }, [])

  const settleActiveRequest = useCallback((confirmed: boolean) => {
    const request = activeRequestRef.current
    if (!request) {
      return
    }
    request.resolve(confirmed)
    setQueue((currentQueue) => {
      if (currentQueue[0]?.id === request.id) {
        return currentQueue.slice(1)
      }
      return currentQueue.filter((queuedRequest) => queuedRequest.id !== request.id)
    })
  }, [])

  return (
    <ConfirmationDialogContext.Provider value={confirm}>
      {children}
      <Dialog
        open={activeRequest !== null}
        onOpenChange={(open) => !open && settleActiveRequest(false)}
      >
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{displayedRequest?.options.title}</DialogTitle>
            {displayedRequest?.options.description ? (
              <DialogDescription>{displayedRequest.options.description}</DialogDescription>
            ) : null}
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => settleActiveRequest(false)}>
              {displayedRequest?.options.cancelLabel ?? 'Cancel'}
            </Button>
            <Button
              type="button"
              variant={displayedRequest?.options.confirmVariant ?? 'default'}
              onClick={() => settleActiveRequest(true)}
            >
              {displayedRequest?.options.confirmLabel ?? 'Confirm'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConfirmationDialogContext.Provider>
  )
}

export function useConfirmationDialog(): ConfirmationDialogContextValue {
  const confirm = useContext(ConfirmationDialogContext)
  if (!confirm) {
    throw new Error('useConfirmationDialog must be used inside ConfirmationDialogProvider')
  }
  return confirm
}
