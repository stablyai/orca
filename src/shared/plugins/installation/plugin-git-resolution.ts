/** How the install dialog's Git input was pinned: `ref` is what install fetches, `commit` what it must get. */
export type PluginGitResolution = {
  kind: 'latest-tag' | 'tag' | 'branch' | 'commit' | 'default-branch'
  ref: string
  commit: string
}

export type PluginGitSourceResolution =
  | ({ ok: true; url: string } & PluginGitResolution)
  | { ok: false; reason: 'ref-not-found'; ref: string }
  | { ok: false; reason: 'unreachable'; error: string }
