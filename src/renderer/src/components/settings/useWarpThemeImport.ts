import { useState } from 'react'
import { toast } from 'sonner'
import type { GlobalSettings } from '../../../../shared/types'
import {
  MAX_TERMINAL_CUSTOM_THEMES,
  normalizeTerminalCustomThemes,
  type TerminalCustomTheme,
  type WarpThemeImportPreview,
  type WarpThemeImportSource
} from '../../../../shared/terminal-custom-themes'
import { useMountedRef } from '../../hooks/useMountedRef'
import { translate } from '@/i18n/i18n'

/** Which entry point opened the import flow; only affects modal copy. */
export type ThemeImportMode = 'warp' | 'yaml'

export type UseWarpThemeImportReturn = {
  open: boolean
  mode: ThemeImportMode
  preview: WarpThemeImportPreview | null
  loading: boolean
  desktopOnly: boolean
  applyError: string | null
  /** Bumps on each successful import so the theme picker can scroll to and
   *  highlight the freshly-imported themes. */
  importSignal: number
  selectedThemeIds: Set<string>
  handleClick: () => Promise<void>
  handleImportYamlClick: () => Promise<void>
  handlePreviewSource: (source: WarpThemeImportSource) => Promise<void>
  handleToggleTheme: (id: string) => void
  handleToggleAll: (checked: boolean) => void
  handleApply: () => Promise<void>
  handleOpenChange: (open: boolean) => void
}

export function useWarpThemeImport(
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>,
  settings: GlobalSettings | null
): UseWarpThemeImportReturn {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<ThemeImportMode>('warp')
  const [preview, setPreview] = useState<WarpThemeImportPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [importSignal, setImportSignal] = useState(0)
  const [selectedThemeIds, setSelectedThemeIds] = useState<Set<string>>(() => new Set())
  const mountedRef = useMountedRef()

  async function previewSource(source: WarpThemeImportSource): Promise<WarpThemeImportPreview> {
    setLoading(true)
    setApplyError(null)
    try {
      const result = await window.api.settings.previewWarpThemeImport(source)
      // Why: a dismissed native picker keeps whatever preview was already
      // showing instead of wiping it with an empty result.
      if (mountedRef.current && !result.canceled) {
        setPreview(result)
        setSelectedThemeIds(new Set(result.themes.map((theme) => theme.id)))
      }
      return result
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : translate('auto.components.settings.useWarpThemeImport.unknown_error', 'Unknown error')
      const failure: WarpThemeImportPreview = {
        found: false,
        themes: [],
        skippedFiles: [],
        error: message
      }
      if (mountedRef.current) {
        setPreview(failure)
        setSelectedThemeIds(new Set())
      }
      return failure
    } finally {
      if (mountedRef.current) {
        setLoading(false)
      }
    }
  }

  async function handlePreviewSource(source: WarpThemeImportSource): Promise<void> {
    await previewSource(source)
  }

  async function handleClick(): Promise<void> {
    setMode('warp')
    setOpen(true)
    await previewSource({ kind: 'auto' })
  }

  async function handleImportYamlClick(): Promise<void> {
    setMode('yaml')
    // Why: go straight to the native picker and only surface the modal once
    // there is a selection to preview — canceling leaves settings untouched.
    const result = await previewSource({ kind: 'chooseFile' })
    if (mountedRef.current && !result.canceled) {
      setOpen(true)
    }
  }

  function handleToggleTheme(id: string): void {
    setSelectedThemeIds((current) => {
      const next = new Set(current)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  function handleToggleAll(checked: boolean): void {
    const targetIds = preview?.themes.map((theme) => theme.id) ?? []
    setSelectedThemeIds(new Set(checked ? targetIds : []))
  }

  async function handleApply(): Promise<void> {
    if (!preview?.found || !settings || selectedThemeIds.size === 0) {
      return
    }
    const selectedThemes = preview.themes.filter((theme) => selectedThemeIds.has(theme.id))
    const byId = new Map<string, TerminalCustomTheme>()
    for (const theme of normalizeTerminalCustomThemes(settings.terminalCustomThemes)) {
      byId.set(theme.id, theme)
    }
    const newThemeCount = selectedThemes.filter((theme) => !byId.has(theme.id)).length
    const overflowCount = byId.size + newThemeCount - MAX_TERMINAL_CUSTOM_THEMES
    if (overflowCount > 0) {
      setApplyError(
        overflowCount === 1
          ? translate(
              'auto.components.settings.useWarpThemeImport.over_limit_one',
              'Importing these themes would exceed the {{value0}} custom terminal theme limit. Deselect 1 new theme and try again.',
              { value0: MAX_TERMINAL_CUSTOM_THEMES }
            )
          : translate(
              'auto.components.settings.useWarpThemeImport.over_limit_other',
              'Importing these themes would exceed the {{value0}} custom terminal theme limit. Deselect {{value1}} new themes and try again.',
              { value0: MAX_TERMINAL_CUSTOM_THEMES, value1: overflowCount }
            )
      )
      return
    }
    for (const theme of selectedThemes) {
      const { selectionValue: _selectionValue, ...themeRecord } = theme
      byId.set(themeRecord.id, themeRecord)
    }

    setApplyError(null)
    try {
      await updateSettings({
        terminalCustomThemes: normalizeTerminalCustomThemes([...byId.values()])
      })
      const count = selectedThemes.length
      // Why: report success via a toast and dismiss the modal rather than
      // leaving an "imported" state inside the dialog.
      toast.success(
        count === 1
          ? translate(
              'auto.components.settings.useWarpThemeImport.imported_one',
              'Imported 1 theme'
            )
          : translate(
              'auto.components.settings.useWarpThemeImport.imported_other',
              'Imported {{value0}} themes',
              { value0: count }
            )
      )
      // Bump the signal so the theme picker scrolls to / highlights the
      // newly-imported themes, which otherwise sit off-screen below the
      // built-in list.
      setImportSignal((value) => value + 1)
      handleOpenChange(false)
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : translate(
              'auto.components.settings.useWarpThemeImport.import_failed',
              'Failed to import themes'
            )
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
      setApplyError(null)
      setSelectedThemeIds(new Set())
    }
  }

  return {
    open,
    mode,
    preview,
    loading,
    desktopOnly: Boolean(preview?.desktopOnly),
    applyError,
    importSignal,
    selectedThemeIds,
    handleClick,
    handleImportYamlClick,
    handlePreviewSource,
    handleToggleTheme,
    handleToggleAll,
    handleApply,
    handleOpenChange
  }
}
