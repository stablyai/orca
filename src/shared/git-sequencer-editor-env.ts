import { addWslEnvKeys } from './wsl-env'

/**
 * Env for sequencer steps that can open the commit-message editor
 * (`merge|rebase|cherry-pick --continue`): with no terminal to close it the
 * child hangs forever. The GIT_EDITOR env var beats `-c core.editor`, so it is
 * the only guard a user's ambient editor config cannot override.
 */
export function editorSuppressedGitEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env, GIT_EDITOR: 'true' }
  if (platform === 'win32') {
    // Why: spawn env does not cross the wsl.exe boundary unless WSLENV names the key.
    addWslEnvKeys(next, ['GIT_EDITOR'])
  }
  return next
}
