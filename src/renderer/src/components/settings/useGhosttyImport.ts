import { useRef, useState } from 'react'
import type {
  GhosttyImportPreview,
  GhosttyImportSource,
  GlobalSettings
} from '../../../../shared/global-settings-types'
import { useMountedRef } from '../../hooks/useMountedRef'
import { withImportedTerminalColorOverrides } from '../../../../shared/terminal-theme-selection'
import { getSystemPrefersDark } from '@/lib/terminal-theme'

export type UseGhosttyImportReturn = {
  open: boolean
  preview: GhosttyImportPreview | null
  loading: boolean
  applied: boolean
  applyError: string | null
  handleClick: () => Promise<void>
  handleChooseFile: () => Promise<void>
  handleApply: () => Promise<void>
  handleOpenChange: (open: boolean) => void
}

export function useGhosttyImport(
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>,
  // Accept unloaded settings so the parent retains stable hook order; defer applying until settings exist.
  settings: GlobalSettings | null
): UseGhosttyImportReturn {
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<GhosttyImportPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [applied, setApplied] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const mountedRef = useMountedRef()
  const choosingRef = useRef(false)

  async function loadPreview(source: GhosttyImportSource): Promise<void> {
    // The picker phase keeps the current preview visible instead of flashing a loading state behind it.
    if (source.kind === 'auto') {
      setLoading(true)
    }
    try {
      const result = await window.api.settings.previewGhosttyImport(source)
      // A dismissed picker keeps the preview that was already showing.
      if (mountedRef.current && !result.canceled) {
        setPreview(result)
        setApplied(false)
        setApplyError(null)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      if (mountedRef.current) {
        setPreview({ found: false, diff: {}, unsupportedKeys: [], error: message })
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false)
      }
    }
  }

  async function handleClick(): Promise<void> {
    setOpen(true)
    await loadPreview({ kind: 'auto' })
  }

  async function handleChooseFile(): Promise<void> {
    if (choosingRef.current) {
      return
    }
    choosingRef.current = true
    try {
      await loadPreview({ kind: 'chooseFile' })
    } finally {
      choosingRef.current = false
    }
  }

  async function handleApply(): Promise<void> {
    if (applied || !preview?.found || Object.keys(preview.diff).length === 0 || !settings) {
      return
    }
    const merged = withImportedTerminalColorOverrides(
      settings,
      preview.diff,
      getSystemPrefersDark()
    )
    setApplyError(null)
    try {
      // Await persistence before marking applied so rejected IPC cannot report success.
      await updateSettings(merged)
      if (mountedRef.current) {
        setApplied(true)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to apply settings'
      if (mountedRef.current) {
        setApplyError(message)
      }
    }
  }

  function handleOpenChange(newOpen: boolean): void {
    setOpen(newOpen)
    if (!newOpen) {
      setPreview(null)
      setLoading(false)
      setApplied(false)
      setApplyError(null)
    }
  }

  return {
    open,
    preview,
    loading,
    applied,
    applyError,
    handleClick,
    handleChooseFile,
    handleApply,
    handleOpenChange
  }
}
