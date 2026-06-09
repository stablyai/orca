import { useCallback, useRef, useState } from 'react'

export function useWorktreeCardDetailsHoverControl() {
  const [open, setOpen] = useState(false)
  const [reviewMenuOpen, setReviewMenuOpen] = useState(false)
  const pendingHoverCloseRef = useRef(false)

  const closeHover = useCallback(() => {
    pendingHoverCloseRef.current = false
    setReviewMenuOpen(false)
    setOpen(false)
  }, [])

  const handleHoverOpenChange = useCallback(
    (next: boolean) => {
      // Why: the portaled PR menu sits outside HoverCardContent — keep the card
      // mounted until the menu closes so the unlink item stays clickable.
      if (reviewMenuOpen) {
        pendingHoverCloseRef.current = !next
        return
      }
      pendingHoverCloseRef.current = false
      setOpen(next)
    },
    [reviewMenuOpen]
  )

  const handleReviewMenuOpenChange = useCallback((next: boolean) => {
    setReviewMenuOpen(next)
    if (!next && pendingHoverCloseRef.current) {
      pendingHoverCloseRef.current = false
      setOpen(false)
    }
  }, [])

  return {
    hoverOpen: open || reviewMenuOpen,
    reviewMenuOpen,
    handleHoverOpenChange,
    handleReviewMenuOpenChange,
    closeHover
  }
}

export type WorktreeCardDetailsHoverControl = ReturnType<typeof useWorktreeCardDetailsHoverControl>
