// Material Icon Theme (MIT): https://github.com/material-extensions/vscode-material-icon-theme
// Why: this module is only loaded via dynamic import when the VS Code icon theme is
// selected, so default-theme users never pay for the manifest or the icon URL table.
import {
  materialIconSvgFileName,
  resolveMaterialFileIconId,
  resolveMaterialFolderIconId,
  type MaterialIconManifest
} from './material-icon-resolver'

const manifestModules = import.meta.glob(
  '../../../../node_modules/material-icon-theme/dist/material-icons.json',
  { eager: true, import: 'default' }
) as Record<string, MaterialIconManifest>

// Why: ?no-inline emits each SVG as its own asset file instead of base64-inlining
// ~1,250 icons into this chunk.
const svgModules = import.meta.glob('../../../../node_modules/material-icon-theme/icons/*.svg', {
  eager: true,
  query: '?no-inline',
  import: 'default'
}) as Record<string, string>

const manifest: MaterialIconManifest | undefined = Object.values(manifestModules)[0]

const urlBySvgFileName = new Map<string, string>()
for (const [path, url] of Object.entries(svgModules)) {
  urlBySvgFileName.set(path.slice(path.lastIndexOf('/') + 1), url)
}

function iconUrl(iconId: string): string | undefined {
  if (!manifest) {
    return undefined
  }
  const fileName = materialIconSvgFileName(manifest, iconId)
  return fileName ? urlBySvgFileName.get(fileName) : undefined
}

export function getMaterialFileIconUrl(pathOrName: string): string | undefined {
  return manifest ? iconUrl(resolveMaterialFileIconId(manifest, pathOrName)) : undefined
}

export function getMaterialFolderIconUrl(pathOrName: string, open: boolean): string | undefined {
  return manifest ? iconUrl(resolveMaterialFolderIconId(manifest, pathOrName, open)) : undefined
}

export type MaterialFileIcons = {
  getMaterialFileIconUrl: typeof getMaterialFileIconUrl
  getMaterialFolderIconUrl: typeof getMaterialFolderIconUrl
}
