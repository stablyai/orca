import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { createWorktreePaletteRequestGuard } from '@/lib/worktree-palette-create-action'
import { PALETTE_CLOSE_LINGER_MS } from './worktree-jump-palette-model'
import { WorktreeJumpPaletteSurface } from './worktree-jump-palette-surface'
import { useWorktreeJumpPaletteController } from './use-worktree-jump-palette-controller'

export default function WorktreeJumpPalette(): React.JSX.Element | null {
  const visible = useAppStore((state) => state.activeModal === 'worktree-palette')
  const [lingering, setLingering] = useState(visible)
  useEffect(() => {
    if (visible) {
      setLingering(true)
      return
    }
    const timer = window.setTimeout(() => setLingering(false), PALETTE_CLOSE_LINGER_MS)
    return () => window.clearTimeout(timer)
  }, [visible])
  // Reopening must invalidate a pending create lookup from the previous content mount.
  const createLookupGuard = useMemo(() => createWorktreePaletteRequestGuard(), [])

  if (!visible && !lingering) {
    return null
  }
  return (
    <WorktreeJumpPaletteContent
      visible={visible}
      lingering={lingering}
      createLookupGuard={createLookupGuard}
    />
  )
}

function WorktreeJumpPaletteContent({
  visible,
  lingering,
  createLookupGuard
}: {
  visible: boolean
  lingering: boolean
  createLookupGuard: ReturnType<typeof createWorktreePaletteRequestGuard>
}): React.JSX.Element {
  const controller = useWorktreeJumpPaletteController({
    visible,
    lingering,
    createLookupGuard
  })
  return <WorktreeJumpPaletteSurface controller={controller} />
}
