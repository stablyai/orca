import { useState } from 'react'
import type { GhosttyImportPreview, GlobalSettings } from '../../../../shared/types'

export type UseGhosttyImportReturn = {
  open: boolean
  preview: GhosttyImportPreview | null
  loading: boolean
  applied: boolean
  handleClick: () => Promise<void>
  handleApply: () => void
  handleOpenChange: (open: boolean) => void
}

export function useGhosttyImport(
  updateSettings: (updates: Partial<GlobalSettings>) => void
): UseGhosttyImportReturn {
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<GhosttyImportPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [applied, setApplied] = useState(false)

  async function handleClick(): Promise<void> {
    setOpen(true)
    setLoading(true)
    try {
      const result = await window.api.settings.previewGhosttyImport()
      setPreview(result)
    } catch {
      setPreview({ found: false, diff: {}, unsupportedKeys: [] })
    } finally {
      setLoading(false)
    }
  }

  function handleApply(): void {
    if (preview?.found && Object.keys(preview.diff).length > 0) {
      updateSettings(preview.diff)
      setApplied(true)
    }
  }

  function handleOpenChange(newOpen: boolean): void {
    setOpen(newOpen)
    if (!newOpen) {
      setPreview(null)
      setLoading(false)
      setApplied(false)
    }
  }

  return { open, preview, loading, applied, handleClick, handleApply, handleOpenChange }
}
