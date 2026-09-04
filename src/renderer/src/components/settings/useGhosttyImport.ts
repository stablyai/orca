import { useState } from 'react'
import type {
  GhosttyImportPreview,
  GhosttyImportSource,
  GlobalSettings
} from '../../../../shared/global-settings-types'
import { useMountedRef } from '../../hooks/useMountedRef'
import { translate } from '@/i18n/i18n'

export type UseGhosttyImportReturn = {
  open: boolean
  preview: GhosttyImportPreview | null
  loading: boolean
  applied: boolean
  applyError: string | null
  handleClick: () => Promise<void>
  handleChooseFileClick: () => Promise<void>
  handleApply: () => Promise<void>
  handleOpenChange: (open: boolean) => void
}

export function useGhosttyImport(
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>,
  // Why: caller may not yet have the settings loaded (the settings page shows
  // a loading spinner before the store resolves). We still need to hold the
  // hook state at the parent level so React hook order stays stable, so accept
  // null and no-op the apply path until settings exist.
  settings: GlobalSettings | null
): UseGhosttyImportReturn {
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<GhosttyImportPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [applied, setApplied] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const mountedRef = useMountedRef()

  async function previewSource(source: GhosttyImportSource): Promise<GhosttyImportPreview> {
    setLoading(true)
    try {
      const result = await window.api.settings.previewGhosttyImport(source)
      // Why: a dismissed native picker keeps whatever preview was already
      // showing instead of wiping it with an empty result.
      if (mountedRef.current && !result.canceled) {
        setPreview(result)
      }
      return result
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : translate('auto.components.settings.useGhosttyImport.unknown_error', 'Unknown error')
      const failure: GhosttyImportPreview = {
        found: false,
        diff: {},
        unsupportedKeys: [],
        error: message
      }
      if (mountedRef.current) {
        setPreview(failure)
      }
      return failure
    } finally {
      if (mountedRef.current) {
        setLoading(false)
      }
    }
  }

  async function handleClick(): Promise<void> {
    setOpen(true)
    await previewSource({ kind: 'auto' })
  }

  async function handleChooseFileClick(): Promise<void> {
    // Why: go straight to the native picker and only surface the modal once
    // there is a config to preview — canceling leaves settings untouched.
    const result = await previewSource({ kind: 'chooseFile' })
    if (mountedRef.current && !result.canceled) {
      setOpen(true)
    }
  }

  async function handleApply(): Promise<void> {
    if (applied || !preview?.found || Object.keys(preview.diff).length === 0 || !settings) {
      return
    }
    const merged = {
      ...preview.diff,
      ...(preview.diff.terminalColorOverrides
        ? {
            terminalColorOverrides: {
              ...settings.terminalColorOverrides,
              ...preview.diff.terminalColorOverrides
            }
          }
        : {})
    }
    setApplyError(null)
    try {
      // Why: updateSettings may be async (settings:set IPC). If it rejects we
      // must keep the modal in its "unapplied" state and surface the error so
      // the user doesn't see a false success.
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
    handleChooseFileClick,
    handleApply,
    handleOpenChange
  }
}
