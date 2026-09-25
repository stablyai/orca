import { useEffect } from 'react'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'

// Hook to initialize window context on component mount.
export function useWindowInit(): void {
  useEffect(() => {
    const initialWorktreeId = (window as any).initialWorktreeId

    if (initialWorktreeId) {
      activateAndRevealWorktree(initialWorktreeId, {})
        .catch((error: unknown) => {
          console.error('Failed to activate worktree:', error)
        })
    }
  }, [])
}
