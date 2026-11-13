// PARITY-DNF: Conductor's cloud runs Amazon Linux (dnf/yum); Orca's sandboxes run Ubuntu (apt).
// An imported setup's own `dnf install` / `yum install` lines become apt-get when every package has
// a clear Ubuntu name; anything else stays as written and is listed for the person to check. A
// script file the setup runs is only read (never changed or run) to say which of its lines use dnf.

/** Amazon Linux / Fedora package → its Ubuntu name, only where the mapping is unambiguous. */
const DNF_TO_APT: Readonly<Record<string, string>> = {
  'bzip2-devel': 'libbz2-dev',
  'ca-certificates': 'ca-certificates',
  curl: 'curl',
  'curl-minimal': 'curl',
  findutils: 'findutils',
  gcc: 'gcc',
  'gcc-c++': 'g++',
  git: 'git',
  'git-lfs': 'git-lfs',
  gzip: 'gzip',
  htop: 'htop',
  jq: 'jq',
  less: 'less',
  'libffi-devel': 'libffi-dev',
  'libpq-devel': 'libpq-dev',
  'libxml2-devel': 'libxml2-dev',
  'libxslt-devel': 'libxslt1-dev',
  'libyaml-devel': 'libyaml-dev',
  make: 'make',
  'ncurses-devel': 'libncurses-dev',
  'openssh-clients': 'openssh-client',
  'openssl-devel': 'libssl-dev',
  patch: 'patch',
  'postgresql-devel': 'libpq-dev',
  'procps-ng': 'procps',
  python3: 'python3',
  'python3-devel': 'python3-dev',
  'python3-pip': 'python3-pip',
  'readline-devel': 'libreadline-dev',
  ripgrep: 'ripgrep',
  rsync: 'rsync',
  'sqlite-devel': 'libsqlite3-dev',
  tar: 'tar',
  tmux: 'tmux',
  unzip: 'unzip',
  'util-linux': 'util-linux',
  vim: 'vim',
  'vim-enhanced': 'vim',
  wget: 'wget',
  which: 'debianutils',
  'xz-devel': 'liblzma-dev',
  zip: 'zip',
  'zlib-devel': 'zlib1g-dev'
}

/** dnf/yum options that only change how it asks or reports; apt-get's own flags replace them. */
const DROPPED_OPTION =
  /^(-y|--assumeyes|-q|--quiet|--nogpgcheck|--allowerasing|--skip-broken|--best|--setopt=\S+)$/

const INSTALL_COMMAND = /^(sudo\s+)?(dnf|yum|microdnf)\s+(.*)$/
/** A line that calls dnf or yum at all (for scanning script files). */
const USES_DNF = /(^|[\s;&|(`])(sudo\s+)?(dnf|yum|microdnf|amazon-linux-extras)\s/

export type DnfTranslation = {
  /** The setup with every translatable install line rewritten. */
  setup: string
  /** Lines rewritten to apt-get. */
  translated: number
  /** dnf/yum commands left as written: an unknown or ambiguous package, or not an install. */
  unresolved: string[]
}

/** One `cmd1 && cmd2; cmd3` piece; null when it is not a dnf/yum command at all. */
function translateCommand(command: string): { apt: string } | { unresolved: true } | null {
  const match = INSTALL_COMMAND.exec(command.trim())
  if (!match) {
    return null
  }
  const words = (match[3] ?? '').split(/\s+/).filter(Boolean)
  const verb = words.findIndex((word) => !word.startsWith('-'))
  // Quotes, variables or globs could name anything: leave them for the person.
  if (verb === -1 || words[verb] !== 'install' || /["'$`*?{}]/.test(command)) {
    return { unresolved: true }
  }
  const packages: string[] = []
  for (const [index, word] of words.entries()) {
    if (index === verb) {
      continue
    }
    if (word.startsWith('-')) {
      if (!DROPPED_OPTION.test(word)) {
        return { unresolved: true }
      }
      continue
    }
    const apt = DNF_TO_APT[word]
    if (!apt) {
      return { unresolved: true }
    }
    if (!packages.includes(apt)) {
      packages.push(apt)
    }
  }
  if (packages.length === 0) {
    return { unresolved: true }
  }
  return {
    apt: `sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ${packages.join(' ')}`
  }
}

/** Rewrites the setup's own dnf/yum install lines to apt-get where every package maps clearly. */
export function translateDnfInstalls(setup: string): DnfTranslation {
  let translated = 0
  const unresolved: string[] = []
  const lines = setup.split('\n').map((line) => {
    // Keep the separators: `a && b; c` pieces are translated one by one.
    const pieces = line.split(/(\s*(?:&&|\|\||;)\s*)/)
    let changed = false
    const out = pieces.map((piece, index) => {
      if (index % 2 === 1) {
        return piece
      }
      const result = translateCommand(piece)
      if (!result) {
        return piece
      }
      if ('unresolved' in result) {
        unresolved.push(piece.trim())
        return piece
      }
      changed = true
      const lead = /^\s*/.exec(piece)?.[0] ?? ''
      return `${lead}${result.apt}`
    })
    if (changed) {
      translated += 1
    }
    return out.join('')
  })
  return { setup: lines.join('\n'), translated, unresolved }
}

/** Script files a setup command runs by path (`./setup.sh`, `bash scripts/setup.sh`). */
export function referencedScriptPaths(setup: string): string[] {
  const paths = new Set<string>()
  for (const word of setup.split(/[\s;&|()]+/)) {
    const path = word.replace(/^\.\//, '')
    if (/\.(sh|bash)$/.test(word) && !word.startsWith('/') && !path.includes('..') && path) {
      paths.add(path)
    }
  }
  return [...paths]
}

/** A script file's lines that call dnf or yum (trimmed, first `limit`). */
export function dnfLinesIn(content: string, limit = 5): string[] {
  const found: string[] = []
  for (const line of content.split('\n')) {
    const text = line.trim()
    if (text && !text.startsWith('#') && USES_DNF.test(text)) {
      found.push(text)
      if (found.length >= limit) {
        break
      }
    }
  }
  return found
}
