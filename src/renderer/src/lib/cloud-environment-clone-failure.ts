// DS-40 (b): why an environment build's clone step failed, from the log lines the user can see.
// Repo contents (submodules, LFS, paths that can't be checked out) are an agent's to fix; access
// and auth are not (an agent can't grant access), so those go to GitHub. Anything unrecognized gets
// neither, so we never point an agent at a problem it can't fix.

export type CloneFailure =
  | { kind: 'content'; repoUrl: string | null }
  | { kind: 'access'; repoUrl: string | null }
  | { kind: 'unknown'; repoUrl: string | null }

const CLONING = /^Cloning (https:\/\/github\.com\/[^\s()]+)/
const COULD_NOT_CLONE = /Could not clone (https:\/\/github\.com\/[^\s()]+?)(?: at |\.\s|\.$|\s|$)/
const ACCESS =
  /repository not found|authentication failed|could not read username|permission denied|invalid username or password|returned error: 40[134]|unable to access|access denied|terminal prompts disabled/i
const CONTENT =
  /submodule|git-lfs|\blfs\b|smudge filter|unable to checkout working tree|invalid path|filename too long|checkout failed|object file .* is empty|unable to create file/i

export function classifyCloneFailure(lines: readonly string[]): CloneFailure {
  let repoUrl: string | null = null
  for (const line of lines) {
    const named = CLONING.exec(line) ?? COULD_NOT_CLONE.exec(line)
    if (named) {
      repoUrl = named[1].replace(/\.git$/, '')
    }
  }
  const text = lines.join('\n')
  // Access first: a 403 next to a submodule mention is still an access problem.
  if (ACCESS.test(text)) {
    return { kind: 'access', repoUrl }
  }
  if (CONTENT.test(text)) {
    return { kind: 'content', repoUrl }
  }
  return { kind: 'unknown', repoUrl }
}

/** `owner/repo` for prompts and copy. */
export function cloneFailureRepoName(repoUrl: string | null): string | null {
  return repoUrl ? repoUrl.replace(/^https:\/\/github\.com\//, '') : null
}
