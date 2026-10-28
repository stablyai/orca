import { parseSetupScriptShebang } from '../setup-script-shebang'
import { detectMonacoFilenameLanguage } from './monaco-filename-language'

function extname(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.')
  const lastSep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  if (lastDot <= lastSep) {
    return ''
  }
  return filePath.slice(lastDot)
}

const EXT_TO_LANGUAGE: Record<string, string> = {
  // Monaco uses typescript/javascript for React and module extensions too; separate React IDs would lose highlighting.
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.cts': 'typescript',
  '.mts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.jsonc': 'json',
  // Dedicated jsonl coloring avoids whole-document JSON diagnostics flagging every record after the first.
  '.jsonl': 'jsonl',
  '.env': 'dotenv',
  '.ipynb': 'notebook',
  '.md': 'markdown',
  '.mdx': 'markdown',
  // Quarto/R Markdown need executable-cell coloring beyond Markdown’s grammar.
  '.qmd': 'quarto',
  '.rmd': 'quarto',
  '.rmarkdown': 'quarto',
  '.mmd': 'mermaid',
  '.mermaid': 'mermaid',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.html': 'html',
  '.htm': 'html',
  // Why: stopgap until a real JSP grammar — 'html' colors the markup; <% %> and ${} stay plain.
  '.jsp': 'html',
  '.jspf': 'html',
  // Final-extension lookup also covers Monaco’s compound .html.liquid association.
  '.liquid': 'liquid',
  '.twig': 'twig',
  '.xml': 'xml',
  '.svg': 'xml',
  '.py': 'python',
  '.rs': 'rust',
  '.zig': 'zig',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.cu': 'cuda-cpp',
  '.cuh': 'cuda-cpp',
  '.cs': 'csharp',
  // Why: Monaco's apex grammar claims only '.cls'; triggers and anonymous-Apex scripts share it.
  '.cls': 'apex',
  '.trigger': 'apex',
  '.apex': 'apex',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.fish': 'shell',
  '.bat': 'bat',
  '.cmd': 'bat',
  '.ps1': 'powershell',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'ini',
  '.ini': 'ini',
  '.cfg': 'ini',
  '.conf': 'ini',
  '.sql': 'sql',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.dockerfile': 'dockerfile',
  '.proto': 'proto',
  '.lua': 'lua',
  '.r': 'r',
  '.make': 'makefile',
  '.scala': 'scala',
  '.groovy': 'groovy',
  '.gvy': 'groovy',
  '.gy': 'groovy',
  '.gsh': 'groovy',
  '.gradle': 'groovy',
  '.jenkinsfile': 'groovy',
  '.dart': 'dart',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.erl': 'erlang',
  '.hrl': 'erlang',
  '.hs': 'haskell',
  '.clj': 'clojure',
  // Why: Monaco registers Solidity under the id 'sol'; 'solidity' is only an alias.
  '.sol': 'sol',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.astro': 'astro',
  '.gjs': 'glimmer-js',
  '.gts': 'glimmer-ts',
  '.sv': 'systemverilog',
  '.svh': 'systemverilog',
  '.v': 'verilog',
  '.vh': 'verilog',
  '.nim': 'nim',
  '.nims': 'nim',
  '.nimble': 'nim',
  '.lean': 'lean',
  '.typ': 'typst',
  '.tf': 'hcl',
  '.hcl': 'hcl',
  '.abap': 'abap',
  '.prisma': 'graphql',
  '.csv': 'csv',
  '.tsv': 'tsv'
}

const FILENAME_TO_LANGUAGE: Record<string, string> = {
  Dockerfile: 'dockerfile',
  Jenkinsfile: 'groovy',
  Makefile: 'makefile',
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
