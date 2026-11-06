import { parseSetupScriptShebang } from '../workspace-setup/setup-script-shebang'
import { detectMonacoFilenameLanguage } from './monaco-filename-language'
import extensionLanguages from './editor-language-extensions.json'

function extname(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.')
  const lastSep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  if (lastDot <= lastSep) {
    return ''
  }
  return filePath.slice(lastDot)
}

const EXT_TO_LANGUAGE: Record<string, string> = extensionLanguages

const FILENAME_TO_LANGUAGE: Record<string, string> = {
  Dockerfile: 'dockerfile',
  Jenkinsfile: 'groovy',
  Makefile: 'makefile',
  Justfile: 'shell',
  '.justfile': 'shell',
  'CMakeLists.txt': 'cmake',
  '.gitignore': 'ini',
  '.gitattributes': 'ini',
  '.editorconfig': 'ini',
  '.env': 'dotenv',
  '.env.local': 'dotenv',
  '.env.development': 'dotenv',
  '.env.production': 'dotenv',
  // .envrc is sourced as a shell script.
  '.envrc': 'shell',
  '.bashrc': 'shell',
  '.bash_profile': 'shell',
  '.bash_login': 'shell',
  '.bash_logout': 'shell',
  '.profile': 'shell',
  '.zshrc': 'shell',
  '.zshenv': 'shell',
  '.zprofile': 'shell',
  '.zlogin': 'shell',
  '.zlogout': 'shell'
}

// Exact match wins; lowercase map covers case-insensitive filesystems.
const FILENAME_LOWER_TO_LANGUAGE: Record<string, string> = Object.fromEntries(
  Object.entries(FILENAME_TO_LANGUAGE).map(([name, language]) => [name.toLowerCase(), language])
)

const SHEBANG_INTERPRETER_TO_LANGUAGE: Record<string, string> = {
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  dash: 'shell',
  ksh: 'shell',
  ash: 'shell',
  fish: 'shell',
  python: 'python',
  pypy: 'python',
  node: 'javascript',
  nodejs: 'javascript',
  deno: 'javascript',
  bun: 'javascript',
  'ts-node': 'typescript',
  tsx: 'typescript',
  ruby: 'ruby',
  perl: 'perl',
  php: 'php',
  lua: 'lua',
  luajit: 'lua',
  pwsh: 'powershell',
  powershell: 'powershell',
  groovy: 'groovy'
}

function detectShebangLanguage(content: string): string | null {
  // Why: scan a bounded prefix so per-keystroke detection stays cheap on large files.
  const interpreter = parseSetupScriptShebang(content.slice(0, 256))?.interpreter.replace(
    /[\d.]+$/,
    ''
  )
  return interpreter !== undefined && Object.hasOwn(SHEBANG_INTERPRETER_TO_LANGUAGE, interpreter)
    ? SHEBANG_INTERPRETER_TO_LANGUAGE[interpreter]
    : null
}

export function detectLanguage(filePath: string, content?: string): string {
  const parts = filePath.split(/[\\/]/)
  const filename = parts.at(-1)!
  if (Object.hasOwn(FILENAME_TO_LANGUAGE, filename)) {
    return FILENAME_TO_LANGUAGE[filename]
  }
  const lowerFilename = filename.toLowerCase()
  if (Object.hasOwn(FILENAME_LOWER_TO_LANGUAGE, lowerFilename)) {
    return FILENAME_LOWER_TO_LANGUAGE[lowerFilename]
  }

  const ext = extname(filename).toLowerCase()
  const lowerName = filename.toLowerCase()
  // Scoped dotenv names fall back to dotenv only when no specific extension matches.
  const language =
    EXT_TO_LANGUAGE[ext] ??
    detectMonacoFilenameLanguage(filename) ??
    // Pipeline variants like Jenkinsfile.release; a known extension (Jenkinsfile.md) still wins.
    (lowerName.startsWith('jenkinsfile.') ? 'groovy' : undefined) ??
    (lowerName === '.env' || lowerName.startsWith('.env.') ? 'dotenv' : 'plaintext')
  // Why: only extensionless names fall back to the shebang; unmapped extensions like .txt stay plaintext.
  if (language === 'plaintext' && ext === '' && content !== undefined) {
    return detectShebangLanguage(content) ?? 'plaintext'
  }
  return language
}
