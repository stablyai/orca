import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  pluginGitCloneArgs,
  pluginGitConfigArgs,
  pluginGitFetchCommitArgs,
  pluginGitTreeArgs
} from './plugins/installation/plugin-git-arguments'

export function registerPluginGitDownloadBinaryCompatibilityCase(
  runGit: (
    args: string[],
    env?: NodeJS.ProcessEnv,
    stdin?: string
  ) => Promise<{ stdout: string; stderr: string }>,
  getRepoPath: () => string
): void {
  // Why pin this: plugin downloads pass every `-c` key and flag below to the user's Git, and a
  // local path counts as the file transport, so the protocol policy is observable offline.
  it('downloads a plugin commit with the exact no-checkout arguments', async () => {
    const source = 'compat-plugin-source'
    await mkdir(join(getRepoPath(), source, 'bin'), { recursive: true })
    await writeFile(join(getRepoPath(), source, 'bin', 'run'), 'plugin\n', { mode: 0o755 })
    await runGit(['init', '-q', source])
    await runGit(['-C', source, 'add', '--all'])
    // Why: Windows ignores the 0o755 file mode, so record the executable bit in the index directly.
    await runGit(['-C', source, 'update-index', '--chmod=+x', 'bin/run'])
    // Why inline identity: a fresh repository does not inherit the fixture repository's config.
    const identity = [
      '-c',
      'user.name=Compatibility Test',
      '-c',
      'user.email=compatibility@example.invalid'
    ]
    await runGit(['-C', source, ...identity, 'commit', '-qm', 'plugin'])
    await runGit(['-C', source, 'tag', 'v1'])
    const commit = (await runGit(['-C', source, 'rev-parse', 'HEAD'])).stdout.trim()
    const config = pluginGitConfigArgs('compat-no-hooks')
    const allowLocal = ['-c', 'protocol.file.allow=always']

    await expect(
      runGit([...config, ...pluginGitCloneArgs(source, 'v1', 'refused')])
    ).rejects.toThrow("transport 'file' not allowed")

    await runGit([...config, ...allowLocal, ...pluginGitCloneArgs(source, 'v1', 'compat-clone')])
    await runGit([...config, 'init', '--quiet', '--template=', 'compat-fetch'])
    await runGit(['-C', 'compat-fetch', ...config, 'remote', 'add', 'origin', `../${source}`])
    await runGit([
      '-C',
      'compat-fetch',
      ...config,
      ...allowLocal,
      ...pluginGitFetchCommitArgs(commit)
    ])
    for (const repository of ['compat-clone', 'compat-fetch']) {
      const tree = await runGit(['-C', repository, ...pluginGitTreeArgs(commit)])
      const [directory, file] = tree.stdout.split('\0')
      expect(directory).toMatch(/^040000 tree [0-9a-f]{40} +-\tbin$/)
      expect(file).toMatch(/^100755 blob [0-9a-f]{40} +7\tbin\/run$/)
      const object = file?.slice(12, 52) ?? ''
      const blob = await runGit(['-C', repository, 'cat-file', '--batch'], {}, `${object}\n`)
      expect(blob.stdout).toBe(`${object} blob 7\nplugin\n\n`)
      // Why: a catalog `path` lists one directory, named relative to it, through `<commit>:<path>`.
      const subtree = await runGit(['-C', repository, ...pluginGitTreeArgs(commit, 'bin')])
      expect(subtree.stdout).toBe(`100755 blob ${object}       7\trun\0`)
    }
  })
}
