import type React from 'react'
import { Database, File, FileArchive, FileCode, Folder, FolderOpen } from 'lucide-react'

export type FileThemeSvgIcon = (props: React.SVGProps<SVGSVGElement>) => React.JSX.Element
export type FolderThemeSvgIcons = {
  closed: FileThemeSvgIcon
  open: FileThemeSvgIcon
}

export const ORCA_COLOR_COMPOUND_EXTENSIONS = ['tar.bz2', 'tar.gz', 'tar.xz']

export const ORCA_COLOR_FILE_BY_NAME: Record<string, FileThemeSvgIcon> = {
  '.env': LockFileIcon,
  '.env.local': LockFileIcon,
  '.gitignore': ConfigFileIcon,
  '.npmrc': ConfigFileIcon,
  '.prettierrc': ConfigFileIcon,
  'bun.lock': PackageFileIcon,
  'bun.lockb': PackageFileIcon,
  'cargo.lock': PackageFileIcon,
  'cargo.toml': PackageFileIcon,
  'cmakelists.txt': ConfigFileIcon,
  codeowners: KeyFileIcon,
  'components.json': ConfigFileIcon,
  'composer.json': PackageFileIcon,
  'composer.lock': PackageFileIcon,
  dockerfile: ConfigFileIcon,
  gemfile: PackageFileIcon,
  'go.mod': PackageFileIcon,
  'go.sum': PackageFileIcon,
  license: KeyFileIcon,
  makefile: TerminalFileIcon,
  'package-lock.json': PackageFileIcon,
  'package.json': PackageFileIcon,
  'pnpm-lock.yaml': PackageFileIcon,
  'pnpm-workspace.yaml': PackageFileIcon,
  'poetry.lock': PackageFileIcon,
  readme: MarkdownFileIcon,
  'readme.md': MarkdownFileIcon,
  security: LockFileIcon,
  'security.md': LockFileIcon,
  'tsconfig.json': ConfigFileIcon,
  'vite.config.js': ConfigFileIcon,
  'vite.config.mjs': ConfigFileIcon,
  'vite.config.ts': ConfigFileIcon,
  'vitest.config.js': ConfigFileIcon,
  'vitest.config.mjs': ConfigFileIcon,
  'vitest.config.ts': ConfigFileIcon,
  'yarn.lock': PackageFileIcon
}

export const ORCA_COLOR_FILE_BY_EXTENSION: Record<string, FileThemeSvgIcon> = {
  '7z': ArchiveFileIcon,
  bash: TerminalFileIcon,
  bat: TerminalFileIcon,
  br: ArchiveFileIcon,
  bz2: ArchiveFileIcon,
  c: CodeFileIcon,
  cc: CodeFileIcon,
  cer: KeyFileIcon,
  cfg: ConfigFileIcon,
  cjs: JavaScriptFileIcon,
  cmd: TerminalFileIcon,
  conf: ConfigFileIcon,
  cpp: CodeFileIcon,
  crt: KeyFileIcon,
  cs: CodeFileIcon,
  css: CssFileIcon,
  cts: TypeScriptFileIcon,
  cxx: CodeFileIcon,
  db: DatabaseFileIcon,
  dmg: ArchiveFileIcon,
  env: LockFileIcon,
  gif: ImageFileIcon,
  go: CodeFileIcon,
  gql: DatabaseFileIcon,
  graphql: DatabaseFileIcon,
  gz: ArchiveFileIcon,
  h: CodeFileIcon,
  hpp: CodeFileIcon,
  htm: HtmlFileIcon,
  html: HtmlFileIcon,
  ico: ImageFileIcon,
  jpeg: ImageFileIcon,
  jpg: ImageFileIcon,
  js: JavaScriptFileIcon,
  json: JsonFileIcon,
  json5: JsonFileIcon,
  jsonc: JsonFileIcon,
  jsx: JavaScriptFileIcon,
  key: KeyFileIcon,
  lock: LockFileIcon,
  log: TextFileIcon,
  md: MarkdownFileIcon,
  mdx: MarkdownFileIcon,
  mjs: JavaScriptFileIcon,
  mts: TypeScriptFileIcon,
  pem: KeyFileIcon,
  png: ImageFileIcon,
  ps1: TerminalFileIcon,
  py: CodeFileIcon,
  rar: ArchiveFileIcon,
  rb: CodeFileIcon,
  rs: CodeFileIcon,
  scss: CssFileIcon,
  sh: TerminalFileIcon,
  sqlite: DatabaseFileIcon,
  sqlite3: DatabaseFileIcon,
  sql: DatabaseFileIcon,
  svg: ImageFileIcon,
  tar: ArchiveFileIcon,
  'tar.bz2': ArchiveFileIcon,
  'tar.gz': ArchiveFileIcon,
  'tar.xz': ArchiveFileIcon,
  ts: TypeScriptFileIcon,
  tsx: TypeScriptFileIcon,
  txt: TextFileIcon,
  xz: ArchiveFileIcon,
  yaml: ConfigFileIcon,
  yml: ConfigFileIcon,
  zip: ArchiveFileIcon,
  zsh: TerminalFileIcon
}

const SOURCE_FOLDER_ICONS = createFolderIconSet({ base: '#2563eb', front: '#60a5fa', label: 'SRC' })
const DOCS_FOLDER_ICONS = createFolderIconSet({ base: '#0f766e', front: '#2dd4bf', label: 'DOC' })
const SHARED_FOLDER_ICONS = createFolderIconSet({ base: '#7c3aed', front: '#a78bfa', label: 'SHR' })
const COMPONENTS_FOLDER_ICONS = createFolderIconSet({
  base: '#db2777',
  front: '#f472b6',
  label: 'UI'
})
const ASSETS_FOLDER_ICONS = createFolderIconSet({ base: '#ea580c', front: '#fb923c', label: 'IMG' })
const TEST_FOLDER_ICONS = createFolderIconSet({ base: '#16a34a', front: '#4ade80', label: 'TST' })
const CONFIG_FOLDER_ICONS = createFolderIconSet({ base: '#475569', front: '#94a3b8', label: 'CFG' })
const SCRIPT_FOLDER_ICONS = createFolderIconSet({ base: '#0f766e', front: '#5eead4', label: '$' })
const PACKAGE_FOLDER_ICONS = createFolderIconSet({
  base: '#ca8a04',
  front: '#facc15',
  label: 'PKG'
})
const BUILD_FOLDER_ICONS = createFolderIconSet({ base: '#64748b', front: '#cbd5e1', label: 'OUT' })
const SERVER_FOLDER_ICONS = createFolderIconSet({ base: '#0284c7', front: '#38bdf8', label: 'API' })
const CLIENT_FOLDER_ICONS = createFolderIconSet({ base: '#4f46e5', front: '#818cf8', label: 'WEB' })

// Why: folder-name cues are the main VS Code icon-theme affordance users notice
// in dense trees, while still keeping v1 compact and Orca-owned.
export const ORCA_COLOR_FOLDER_BY_NAME: Record<string, FolderThemeSvgIcons> = {
  '.github': CONFIG_FOLDER_ICONS,
  '.vscode': CONFIG_FOLDER_ICONS,
  __tests__: TEST_FOLDER_ICONS,
  api: SERVER_FOLDER_ICONS,
  app: CLIENT_FOLDER_ICONS,
  assets: ASSETS_FOLDER_ICONS,
  backend: SERVER_FOLDER_ICONS,
  build: BUILD_FOLDER_ICONS,
  client: CLIENT_FOLDER_ICONS,
  components: COMPONENTS_FOLDER_ICONS,
  config: CONFIG_FOLDER_ICONS,
  configs: CONFIG_FOLDER_ICONS,
  dist: BUILD_FOLDER_ICONS,
  doc: DOCS_FOLDER_ICONS,
  docs: DOCS_FOLDER_ICONS,
  documentation: DOCS_FOLDER_ICONS,
  frontend: CLIENT_FOLDER_ICONS,
  images: ASSETS_FOLDER_ICONS,
  lib: SHARED_FOLDER_ICONS,
  node_modules: PACKAGE_FOLDER_ICONS,
  out: BUILD_FOLDER_ICONS,
  package: PACKAGE_FOLDER_ICONS,
  packages: PACKAGE_FOLDER_ICONS,
  public: ASSETS_FOLDER_ICONS,
  script: SCRIPT_FOLDER_ICONS,
  scripts: SCRIPT_FOLDER_ICONS,
  server: SERVER_FOLDER_ICONS,
  shared: SHARED_FOLDER_ICONS,
  source: SOURCE_FOLDER_ICONS,
  src: SOURCE_FOLDER_ICONS,
  test: TEST_FOLDER_ICONS,
  tests: TEST_FOLDER_ICONS,
  tool: SCRIPT_FOLDER_ICONS,
  tools: SCRIPT_FOLDER_ICONS,
  ui: COMPONENTS_FOLDER_ICONS,
  web: CLIENT_FOLDER_ICONS
}

type ColoredFileIconProps = React.SVGProps<SVGSVGElement> & {
  color?: string
  accent?: string
  label?: string
}

type ColoredFolderIconProps = React.SVGProps<SVGSVGElement> & {
  base: string
  front: string
  label?: string
  open?: boolean
}

function createFolderIconSet({
  base,
  front,
  label
}: {
  base: string
  front: string
  label?: string
}): FolderThemeSvgIcons {
  return {
    closed: function ColorFolderClosedIcon(props): React.JSX.Element {
      return <ColorFolderBase base={base} front={front} label={label} {...props} />
    },
    open: function ColorFolderOpenedIcon(props): React.JSX.Element {
      return <ColorFolderBase base={base} front={front} label={label} open {...props} />
    }
  }
}

// Why: these colors are part of the icon asset artwork, not UI chrome tokens;
// keeping them self-contained avoids coupling file-type identity to app theme colors.
function ColorFileBase({
  color = '#64748b',
  accent = '#f8fafc',
  label,
  children,
  ...props
}: ColoredFileIconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" {...props}>
      <path
        d="M3 1.5h6.25L13 5.25V13a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 13V1.5Z"
        fill={color}
      />
      <path d="M9.25 1.5v3.75H13" fill={accent} opacity="0.45" />
      {label ? (
        <text
          x="8"
          y="11"
          textAnchor="middle"
          fontSize="4.2"
          fontFamily="Geist, sans-serif"
          fontWeight="700"
          fill={accent}
        >
          {label}
        </text>
      ) : (
        children
      )}
    </svg>
  )
}

export function DefaultFileIcon(props: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return <ColorFileBase color="#64748b" {...props} />
}

export function TypeScriptFileIcon(props: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return <ColorFileBase color="#3178c6" label="TS" {...props} />
}

function CodeFileIcon(props: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return <ColorFileBase color="#3b82f6" label="<>" {...props} />
}

function JavaScriptFileIcon(props: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return <ColorFileBase color="#d6a100" accent="#111827" label="JS" {...props} />
}

function JsonFileIcon(props: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return <ColorFileBase color="#f59e0b" label="{}" {...props} />
}

function MarkdownFileIcon(props: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return <ColorFileBase color="#64748b" label="MD" {...props} />
}

function CssFileIcon(props: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return <ColorFileBase color="#7c3aed" label="#" {...props} />
}

function HtmlFileIcon(props: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return <ColorFileBase color="#ea580c" label="<>" {...props} />
}

function ImageFileIcon(props: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return (
    <ColorFileBase color="#14b8a6" {...props}>
      <circle cx="6" cy="6" r="1" fill="#ecfeff" />
      <path d="m4.5 11 2.4-2.6 1.5 1.5 1.2-1.2 2 2.3H4.5Z" fill="#ecfeff" />
    </ColorFileBase>
  )
}

function ArchiveFileIcon(props: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return <ColorFileBase color="#a16207" label="ZIP" {...props} />
}

function LockFileIcon(props: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return <ColorFileBase color="#475569" label="LOCK" {...props} />
}

function KeyFileIcon(props: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return <ColorFileBase color="#ca8a04" label="KEY" {...props} />
}

function ConfigFileIcon(props: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return <ColorFileBase color="#6b7280" label="CFG" {...props} />
}

function PackageFileIcon(props: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return <ColorFileBase color="#16a34a" label="PKG" {...props} />
}

function TerminalFileIcon(props: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return <ColorFileBase color="#0f766e" label="$" {...props} />
}

function DatabaseFileIcon(props: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return <ColorFileBase color="#2563eb" label="DB" {...props} />
}

function TextFileIcon(props: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return <ColorFileBase color="#64748b" label="TXT" {...props} />
}

function ColorFolderBase({
  base,
  front,
  label,
  open = false,
  ...props
}: ColoredFolderIconProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" {...props}>
      {open ? (
        <>
          <path
            d="M1.5 5A1.75 1.75 0 0 1 3.25 3.25h3L7.75 4.75h5A1.75 1.75 0 0 1 14.5 6.5v.75h-13V5Z"
            fill={base}
          />
          <path
            d="M2.25 6.5h12.5l-1.3 5.3a1.75 1.75 0 0 1-1.7 1.33h-9.3a1.25 1.25 0 0 1-1.22-1.55L2.25 6.5Z"
            fill={front}
          />
        </>
      ) : (
        <>
          <path
            d="M1.5 4.25A1.75 1.75 0 0 1 3.25 2.5h3l1.5 1.5h5A1.75 1.75 0 0 1 14.5 5.75v6A1.75 1.75 0 0 1 12.75 13.5h-9.5A1.75 1.75 0 0 1 1.5 11.75v-7.5Z"
            fill={base}
          />
          <path
            d="M1.5 6h13v5.75a1.75 1.75 0 0 1-1.75 1.75h-9.5A1.75 1.75 0 0 1 1.5 11.75V6Z"
            fill={front}
          />
        </>
      )}
      {label ? (
        <text
          x="8"
          y="11.4"
          textAnchor="middle"
          fontSize="3.2"
          fontFamily="Geist, sans-serif"
          fontWeight="800"
          fill="#0f172a"
          opacity="0.9"
        >
          {label}
        </text>
      ) : null}
    </svg>
  )
}

export function ColorFolderIcon(props: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return <ColorFolderBase base="#d99a28" front="#f2b84b" {...props} />
}

export function ColorFolderOpenIcon(props: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return <ColorFolderBase base="#d99a28" front="#f2b84b" open {...props} />
}

export const FILE_ICON_THEME_PREVIEW_ICONS = {
  orca: { File, Folder, FolderOpen, FileCode, FileArchive, Database },
  'orca-color': {
    File: TypeScriptFileIcon,
    Folder: ColorFolderIcon,
    FolderOpen: ColorFolderOpenIcon
  }
} as const
