import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

type AppearanceLeaveRequest = {
  discardDraftOnLeave: boolean
  resolve: (allowed: boolean) => void
}

type UseAppearanceLeaveDialogOptions = {
  hasChanges: boolean
  draftSaving?: boolean
  draftSaveFailed?: boolean
  saveDraft: () => Promise<boolean>
  discardDraft: () => void
}

export type AppearanceLeaveDialog = {
  open: boolean
  saving: boolean
  saveFailed: boolean
  confirmLeave: (options: { discardDraftOnLeave: boolean }) => Promise<boolean>
  save: () => void
  discard: () => void
  cancel: () => void
}

export function useAppearanceLeaveDialog({
  hasChanges,
  draftSaving = false,
  draftSaveFailed = false,
  saveDraft,
  discardDraft
}: UseAppearanceLeaveDialogOptions): AppearanceLeaveDialog {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const hasChangesRef = useRef(hasChanges)
  const draftSavingRef = useRef(draftSaving)
  const saveDraftRef = useRef(saveDraft)
  const discardDraftRef = useRef(discardDraft)
  const requestRef = useRef<AppearanceLeaveRequest | null>(null)
  const pendingPromiseRef = useRef<Promise<boolean> | null>(null)
  const busy = saving || draftSaving

  useLayoutEffect(() => {
    hasChangesRef.current = hasChanges
    draftSavingRef.current = draftSaving
    saveDraftRef.current = saveDraft
    discardDraftRef.current = discardDraft
  }, [discardDraft, draftSaving, hasChanges, saveDraft])

  const settle = useCallback((allowed: boolean): void => {
    const request = requestRef.current
    if (!request) {
      return
    }
    requestRef.current = null
    pendingPromiseRef.current = null
    setOpen(false)
    setSaving(false)
    setSaveFailed(false)
    request.resolve(allowed)
  }, [])

  const confirmLeave = useCallback(
    ({ discardDraftOnLeave }: { discardDraftOnLeave: boolean }): Promise<boolean> => {
      if (!hasChangesRef.current) {
        return Promise.resolve(true)
      }
      if (pendingPromiseRef.current) {
        return pendingPromiseRef.current
      }
      const pending = new Promise<boolean>((resolve) => {
        requestRef.current = { discardDraftOnLeave, resolve }
        setSaveFailed(false)
        setOpen(true)
      })
      pendingPromiseRef.current = pending
      // Avoid a duplicate save; saveDraft returns the active promise.
      if (draftSavingRef.current) {
        void saveDraftRef
          .current()
          .then((clean) => {
            if (clean) {
              settle(true)
            }
          })
          .catch(() => {
            setSaving(false)
            setSaveFailed(true)
          })
      }
      return pending
    },
    [settle]
  )

  const save = useCallback((): void => {
    if (!requestRef.current || busy) {
      return
    }
    setSaving(true)
    setSaveFailed(false)
    void saveDraftRef
      .current()
      .then((clean) => {
        if (clean) {
          settle(true)
          return
        }
        setSaving(false)
      })
      .catch(() => {
        setSaving(false)
        setSaveFailed(true)
      })
  }, [busy, settle])

  const discard = useCallback((): void => {
    const request = requestRef.current
    if (!request || busy) {
      return
    }
    if (request.discardDraftOnLeave) {
      discardDraftRef.current()
    }
    settle(true)
  }, [busy, settle])

  const cancel = useCallback((): void => {
    if (!busy) {
      settle(false)
    }
  }, [busy, settle])

  useEffect(() => {
    return () => {
      requestRef.current?.resolve(false)
      requestRef.current = null
      pendingPromiseRef.current = null
    }
  }, [])

  return {
    open,
    saving: busy,
    saveFailed: saveFailed || draftSaveFailed,
    confirmLeave,
    save,
    discard,
    cancel
  }
}
