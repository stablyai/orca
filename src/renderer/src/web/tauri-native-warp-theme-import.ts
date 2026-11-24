// Warp theme import preview, renderer-side for Tauri.
//
// Electron main scans the Warp channel theme folders and parses each YAML
// file. Tauri reuses the shared YAML parser on the renderer but lists the
// channel directories through poc_list_directory (bounded to the authorized
// roots) and reads each file through the staged-external channel. The manual
// pickers go through the Tauri dialog plugin.

import type {
  WarpThemeImportPreview,
  WarpThemeImportPreviewTheme,
  WarpThemeImportSkippedFile,
  WarpThemeImportSource
} from '../../../shared/terminal-themes/terminal-custom-themes'
import { makeCustomTerminalThemeSelection } from '../../../shared/terminal-themes/terminal-custom-themes'
import { parseWarpThemeYaml } from '../../../main/warp-themes/parser'
import { invokeNative, invokePlugin } from './tauri-native-host'
import { translate } from '../i18n/i18n'
import { readStagedFileText, stagePath } from './tauri-native-staged-read'

const MAX_THEME_FILE_BYTES = 1_000_000

// Warp channel ids shipped on Windows; each holds data\themes under
// %APPDATA%\warp\<channel>.
const WARP_CHANNELS = ['Warp', 'WarpPreview', 'WarpOss', 'WarpDev', 'WarpLocal', 'WarpIntegration']

type ListedEntry = { name: string; isDirectory: boolean; isFile: boolean; isSymlink: boolean }

type ThemeFileRef = { path: string; label: string; sourceLabel: string }

function warpThemeDirectories(): string[] {
  const appData =
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: WebView2 exposes no process env; fall back to the roaming profile root Electron resolves on Windows.
    ((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
      ?.APPDATA as string | undefined) ?? ''
  const base = appData || 'C:\\Users\\Default\\AppData\\Roaming'
  return WARP_CHANNELS.map((channel) => `${base}\\warp\\${channel}\\data\\themes`)
}

async function filesFromAutoDirectories(): Promise<{
  files: ThemeFileRef[]
  skippedFiles: WarpThemeImportSkippedFile[]
}> {
  const files: ThemeFileRef[] = []
  const skippedFiles: WarpThemeImportSkippedFile[] = []
  for (const dir of warpThemeDirectories()) {
    let entries: ListedEntry[]
    try {
      const result = await invokeNative<{ entries: ListedEntry[] }>('poc_list_directory', {
        path: dir
      })
      entries = result.entries
    } catch {
      continue
    }
    const channelLabel = dir.split('\\').at(-3) ?? 'Warp themes'
    for (const entry of entries) {
      if (!entry.isFile || !/\.ya?ml$/i.test(entry.name)) {
        continue
      }
      files.push({
        path: `${dir}\\${entry.name}`,
        label: entry.name,
        sourceLabel: channelLabel
      })
    }
  }
  return { files, skippedFiles }
}

export async function previewTauriWarpThemeImport(
  source: WarpThemeImportSource = { kind: 'auto' }
): Promise<WarpThemeImportPreview> {
  let files: ThemeFileRef[]
  let sourceLabel = 'Warp themes'
  const skippedFiles: WarpThemeImportSkippedFile[] = []

  if (source.kind === 'chooseFile') {
    const picked = await invokePlugin<string | string[] | null>('dialog', 'open', {
      options: {
        title: translate('auto.web.tauriNative.dialog.importWarpThemes', 'Import Warp themes'),
        multiple: true,
        filters: [{ name: 'Warp themes', extensions: ['yaml', 'yml'] }]
      }
    })
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : []
    if (paths.length === 0) {
      return { found: false, canceled: true, themes: [], skippedFiles: [] }
    }
    files = paths.map((p) => ({
      path: p,
      label: p.split(/[\\/]/).at(-1) ?? p,
      sourceLabel: 'Selected files'
    }))
    sourceLabel = 'Selected files'
  } else if (source.kind === 'chooseFolder') {
    const picked = await invokePlugin<string | string[] | null>('dialog', 'open', {
      options: {
        title: translate(
          'auto.web.tauriNative.dialog.importWarpThemesFolder',
          'Import Warp themes folder'
        ),
        directory: true,
        multiple: false
      }
    })
    const folder = Array.isArray(picked) ? picked[0] : picked
    if (!folder) {
      return { found: false, canceled: true, themes: [], skippedFiles: [] }
    }
    try {
      const result = await invokeNative<{ entries: ListedEntry[] }>('poc_list_directory', {
        path: folder
      })
      files = result.entries
        .filter((e) => e.isFile && /\.ya?ml$/i.test(e.name))
        .map((e) => ({ path: `${folder}\\${e.name}`, label: e.name, sourceLabel: folder }))
      sourceLabel = folder
    } catch {
      files = []
    }
  } else {
    const auto = await filesFromAutoDirectories()
    files = auto.files
    skippedFiles.push(...auto.skippedFiles)
    if (files.length === 0) {
      return { found: false, sourceLabel, themes: [], skippedFiles }
    }
  }

  const themes: WarpThemeImportPreviewTheme[] = []
  const idCounts = new Map<string, number>()
  const importedAt = new Date().toISOString()

  for (const file of files) {
    const staged = await stagePath(file.path)
    if (staged.source.status !== 'staged' || !staged.file) {
      skippedFiles.push({ label: file.label, reason: 'Could not read file.' })
      continue
    }
    let content: string
    try {
      content = await readStagedFileText(file.path, staged.file, MAX_THEME_FILE_BYTES)
    } catch {
      skippedFiles.push({ label: file.label, reason: 'Could not read file.' })
      continue
    }
    const parsed = parseWarpThemeYaml(content, file.label, {
      idDiscriminator: file.label,
      importedAt,
      sourceLabel: file.sourceLabel
    })
    if (!parsed.ok) {
      skippedFiles.push({ label: file.label, reason: parsed.reason })
      continue
    }
    const count = idCounts.get(parsed.theme.id) ?? 0
    idCounts.set(parsed.theme.id, count + 1)
    if (count > 0) {
      const id = `${parsed.theme.id}-${count + 1}`
      themes.push({ ...parsed.theme, id, selectionValue: makeCustomTerminalThemeSelection(id) })
    } else {
      themes.push(parsed.theme)
    }
  }

  return { found: themes.length > 0, sourceLabel, themes, skippedFiles }
}
