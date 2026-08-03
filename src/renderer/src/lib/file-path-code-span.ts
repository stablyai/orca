import { parseExplicitFileLinkTarget } from './explicit-file-link-target'

// Whether a whole inline-code span is a file path worth linkifying.
//
// A backtick span is an authoring signal, so a bare `package.json` qualifies
// here even though prose requires a separator — in prose the same rule would
// linkify version numbers and hostnames. Separator-less spans still need a
// known extension; spans with a separator accept any plausible one.

const MAX_CODE_SPAN_LENGTH = 512

// Files agents reference by name with no extension.
const EXTENSIONLESS_FILENAMES = new Set([
  'dockerfile',
  'makefile',
  'procfile',
  'rakefile',
  'gemfile',
  'justfile',
  'brewfile',
  'jenkinsfile',
  'vagrantfile',
  'codeowners'
])

// Only consulted for separator-less spans, where the extension is the sole signal.
const BARE_NAME_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'json',
  'jsonc',
  'md',
  'mdx',
  'txt',
  'yml',
  'yaml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'env',
  'lock',
  'sh',
  'bash',
  'zsh',
  'fish',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'swift',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'cs',
  'php',
  'sql',
  'css',
  'scss',
  'less',
  'html',
  'xml',
  'svg',
  'vue',
  'svelte',
  'astro',
  'graphql',
  'proto',
  'gradle'
])

function hasNonFileScheme(value: string): boolean {
  // A Windows drive letter (C:\repo) is not a scheme.
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    return false
  }
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
}

// A mid-token '@' marks an email or git remote (git@github.com:org/repo); a
// segment-leading '@' is a scoped package directory and stays eligible.
function hasMidTokenAt(value: string): boolean {
  return /[^\\/]@/.test(value)
}

export function isFilePathCodeSpan(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > MAX_CODE_SPAN_LENGTH || /[\r\n]/.test(trimmed)) {
    return false
  }
  if (hasNonFileScheme(trimmed) || hasMidTokenAt(trimmed)) {
    return false
  }
  // Reuse the click path's parser so a span that passes here resolves to the
  // same pathText when it is opened.
  const parsed = parseExplicitFileLinkTarget(trimmed)
  if (!parsed) {
    return false
  }
  const { pathText } = parsed
  const lastSeparator = Math.max(pathText.lastIndexOf('/'), pathText.lastIndexOf('\\'))
  const lastSegment = pathText.slice(lastSeparator + 1)
  if (!lastSegment) {
    return false
  }
  if (EXTENSIONLESS_FILENAMES.has(lastSegment.toLowerCase())) {
    return true
  }
  const dot = lastSegment.lastIndexOf('.')
  if (dot < 0) {
    return false
  }
  const extension = lastSegment.slice(dot + 1).toLowerCase()
  if (!extension || !/^[a-z0-9]+$/.test(extension)) {
    return false
  }
  // A purely numeric tail is a version number ("1.2.3"), not an extension.
  if (/^\d+$/.test(extension)) {
    return false
  }
  return lastSeparator >= 0 || BARE_NAME_EXTENSIONS.has(extension)
}
