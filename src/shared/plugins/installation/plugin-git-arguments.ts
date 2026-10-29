/** Exact Git argv for plugin downloads, shared with the real-binary compatibility matrix. */

const PLUGIN_GIT_SETTINGS = [
  // Why per-protocol keys too: a user's `protocol.<name>.allow` outranks `protocol.allow`, and
  // an insteadOf rewrite or a redirect must not reach file, ext or plain-http transports.
  'protocol.allow=never',
  'protocol.https.allow=always',
  'protocol.ssh.allow=always',
  ...['file', 'ext', 'git', 'http', 'ftp', 'ftps'].map((name) => `protocol.${name}.allow=never`),
  'submodule.recurse=false',
  'fetch.recurseSubmodules=false',
  'gc.auto=0',
  'maintenance.auto=false',
  'init.defaultObjectFormat=sha1',
  // Why: keeps every fetched object in one pack so the size watcher sees it grow.
  'fetch.unpackLimit=0'
]

/** An empty hooksPath and template stop user or global hooks (e.g. reference-transaction);
 *  unknown keys are ignored by older Git, so these stay 2.25-safe. */
export function pluginGitConfigArgs(emptyHooksPath: string): string[] {
  return [`core.hooksPath=${emptyHooksPath}`, ...PLUGIN_GIT_SETTINGS].flatMap((setting) => [
    '-c',
    setting
  ])
}

export function pluginGitCloneArgs(url: string, ref: string, repository: string): string[] {
  return [
    'clone',
    '--quiet',
    '--no-checkout',
    '--no-local',
    '--template=',
    '--depth',
    '1',
    ...(ref.length > 0 ? ['--branch', ref] : []),
    '--',
    url,
    repository
  ]
}

export function pluginGitFetchCommitArgs(commit: string): string[] {
  return ['fetch', '--quiet', '--no-tags', '--depth', '1', 'origin', commit]
}

/** `path` lists only that directory, with entries relative to it (`<commit>:<path>` tree-ish). */
export function pluginGitTreeArgs(commit: string, path?: string): string[] {
  return ['ls-tree', '-r', '-t', '-l', '-z', '--full-tree', path ? `${commit}:${path}` : commit]
}
