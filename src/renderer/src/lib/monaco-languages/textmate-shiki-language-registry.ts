import type * as Monaco from 'monaco-editor'

export type OrcaShikiLanguageRegistration = {
  monacoLanguageId: string
  shikiLanguageId: string
  language?: Monaco.languages.ILanguageExtensionPoint
}

export const ORCA_SHIKI_LANGUAGE_REGISTRY: readonly OrcaShikiLanguageRegistration[] = [
  { monacoLanguageId: 'typescript', shikiLanguageId: 'tsx' },
  { monacoLanguageId: 'javascript', shikiLanguageId: 'jsx' },
  { monacoLanguageId: 'json', shikiLanguageId: 'jsonc' },
  { monacoLanguageId: 'markdown', shikiLanguageId: 'markdown' },
  {
    monacoLanguageId: 'mermaid',
    shikiLanguageId: 'mermaid',
    language: { id: 'mermaid', extensions: ['.mmd', '.mermaid'], aliases: ['Mermaid'] }
  },
  { monacoLanguageId: 'css', shikiLanguageId: 'css' },
  { monacoLanguageId: 'scss', shikiLanguageId: 'scss' },
  { monacoLanguageId: 'less', shikiLanguageId: 'less' },
  { monacoLanguageId: 'html', shikiLanguageId: 'html' },
  { monacoLanguageId: 'xml', shikiLanguageId: 'xml' },
  { monacoLanguageId: 'python', shikiLanguageId: 'python' },
  { monacoLanguageId: 'rust', shikiLanguageId: 'rust' },
  { monacoLanguageId: 'go', shikiLanguageId: 'go' },
  { monacoLanguageId: 'java', shikiLanguageId: 'java' },
  { monacoLanguageId: 'kotlin', shikiLanguageId: 'kotlin' },
  { monacoLanguageId: 'c', shikiLanguageId: 'c' },
  { monacoLanguageId: 'cpp', shikiLanguageId: 'cpp' },
  { monacoLanguageId: 'csharp', shikiLanguageId: 'csharp' },
  { monacoLanguageId: 'ruby', shikiLanguageId: 'ruby' },
  { monacoLanguageId: 'php', shikiLanguageId: 'php' },
  { monacoLanguageId: 'swift', shikiLanguageId: 'swift' },
  { monacoLanguageId: 'shell', shikiLanguageId: 'shellscript' },
  { monacoLanguageId: 'bat', shikiLanguageId: 'bat' },
  { monacoLanguageId: 'powershell', shikiLanguageId: 'powershell' },
  { monacoLanguageId: 'yaml', shikiLanguageId: 'yaml' },
  { monacoLanguageId: 'ini', shikiLanguageId: 'ini' },
  {
    monacoLanguageId: 'toml',
    shikiLanguageId: 'toml',
    language: { id: 'toml', extensions: ['.toml'], aliases: ['TOML'] }
  },
  { monacoLanguageId: 'sql', shikiLanguageId: 'sql' },
  { monacoLanguageId: 'graphql', shikiLanguageId: 'graphql' },
  { monacoLanguageId: 'dockerfile', shikiLanguageId: 'docker' },
  {
    monacoLanguageId: 'protobuf',
    shikiLanguageId: 'proto',
    language: { id: 'protobuf', extensions: ['.proto'], aliases: ['Protocol Buffers'] }
  },
  { monacoLanguageId: 'lua', shikiLanguageId: 'lua' },
  { monacoLanguageId: 'r', shikiLanguageId: 'r' },
  { monacoLanguageId: 'scala', shikiLanguageId: 'scala' },
  { monacoLanguageId: 'dart', shikiLanguageId: 'dart' },
  { monacoLanguageId: 'elixir', shikiLanguageId: 'elixir' },
  {
    monacoLanguageId: 'erlang',
    shikiLanguageId: 'erlang',
    language: { id: 'erlang', extensions: ['.erl', '.hrl'], aliases: ['Erlang'] }
  },
  {
    monacoLanguageId: 'haskell',
    shikiLanguageId: 'haskell',
    language: { id: 'haskell', extensions: ['.hs'], aliases: ['Haskell'] }
  },
  { monacoLanguageId: 'clojure', shikiLanguageId: 'clojure' },
  {
    monacoLanguageId: 'vue',
    shikiLanguageId: 'vue',
    language: { id: 'vue', extensions: ['.vue'], aliases: ['Vue'] }
  },
  {
    monacoLanguageId: 'svelte',
    shikiLanguageId: 'svelte',
    language: { id: 'svelte', extensions: ['.svelte'], aliases: ['Svelte'] }
  },
  {
    monacoLanguageId: 'astro',
    shikiLanguageId: 'astro',
    language: { id: 'astro', extensions: ['.astro'], aliases: ['Astro'] }
  },
  { monacoLanguageId: 'systemverilog', shikiLanguageId: 'system-verilog' },
  { monacoLanguageId: 'verilog', shikiLanguageId: 'verilog' },
  {
    monacoLanguageId: 'nim',
    shikiLanguageId: 'nim',
    language: {
      id: 'nim',
      extensions: ['.nim', '.nims', '.nimble'],
      aliases: ['Nim', 'nim']
    }
  },
  { monacoLanguageId: 'hcl', shikiLanguageId: 'terraform' },
  {
    monacoLanguageId: 'csv',
    shikiLanguageId: 'csv',
    language: { id: 'csv', extensions: ['.csv'], aliases: ['CSV'] }
  },
  {
    monacoLanguageId: 'tsv',
    shikiLanguageId: 'tsv',
    language: { id: 'tsv', extensions: ['.tsv'], aliases: ['TSV'] }
  },
  {
    monacoLanguageId: 'makefile',
    shikiLanguageId: 'make',
    language: { id: 'makefile', filenames: ['Makefile'], aliases: ['Makefile'] }
  },
  {
    monacoLanguageId: 'cmake',
    shikiLanguageId: 'cmake',
    language: {
      id: 'cmake',
      extensions: ['.cmake'],
      filenames: ['CMakeLists.txt'],
      aliases: ['CMake']
    }
  }
]
