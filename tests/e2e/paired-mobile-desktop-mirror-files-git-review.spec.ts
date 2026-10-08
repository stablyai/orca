/**
 * Files, Source Control and review for a server workspace, from a phone paired with the desktop:
 * each call names the server with `executionHost`, and its effect lands on the server, never the Mac.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { expect, test } from './helpers/orca-app'
import { launchPhoneMirrorTopology } from './helpers/phone-mirror-topology'
import type { PairedMobileSocket } from './helpers/paired-mobile-client'

type Frame = PairedMobileSocket['frames'][number]

const HostWorktreesSchema = z.looseObject({
  worktrees: z.array(z.looseObject({ worktreeId: z.string(), path: z.string() })),
  stale: z.boolean()
})
const ReposSchema = z.object({
  repos: z.array(z.looseObject({ id: z.string(), path: z.string() }))
})

let requestCount = 0

async function send(
  socket: PairedMobileSocket,
  method: string,
  params: unknown,
  executionHost?: string
): Promise<Frame> {
  requestCount += 1
  const id = `${method}-${requestCount}`
  socket.send(id, method, params, executionHost)
  let found: Frame | undefined
  await expect
    .poll(() => (found = socket.frames.find((frame) => frame.id === id)), { timeout: 30_000 })
    .toBeDefined()
  return found!
}

async function result(
  socket: PairedMobileSocket,
  method: string,
  params: unknown,
  executionHost?: string
): Promise<unknown> {
  const frame = await send(socket, method, params, executionHost)
  expect(frame.ok, `${method}: ${JSON.stringify(frame.error)}`).toBe(true)
  return frame.result
}

function gitRepo(dir: string, remote: string): (...args: string[]) => string {
  mkdirSync(dir, { recursive: true })
  // Why: the runner's own git config must not shape the repo the server reads.
  const env = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' }
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, env, stdio: 'pipe', encoding: 'utf8' })
  writeFileSync(path.join(dir, 'NOTES.md'), 'first\n')
  git('init')
  git('checkout', '-b', 'main')
  // Why: the server runs with an isolated HOME, so the repo carries its own identity.
  git('config', 'user.name', 'E2E')
  git('config', 'user.email', 'e2e@test.local')
  git('remote', 'add', 'origin', remote)
  git('add', 'NOTES.md')
  git('commit', '-m', 'init')
  return git
}

test('phone reads, uploads, commits and reviews in a server workspace through the desktop', async () => {
  const testInfo = test.info()
  test.setTimeout(180_000)
  const githubRepo = testInfo.outputPath('server-github-repo')
  const git = gitRepo(githubRepo, 'https://github.com/acme/server-github-repo.git')
  writeFileSync(path.join(githubRepo, 'NOTES.md'), 'changed on the server\n')

  const { host, phone, dispose } = await launchPhoneMirrorTopology({ phoneTo: 'desktop' }, testInfo)
  try {
    await host.client.call('repo.add', { path: githubRepo, kind: 'git' })
    const socket = await phone.openSocket()
    const hosts = z
      .object({ hosts: z.array(z.looseObject({ hostId: z.string() })) })
      .parse(await result(socket, 'mobileRelay.hosts.list', {}))
    const server = hosts.hosts.find((row) => row.hostId.startsWith('runtime:'))?.hostId ?? ''
    expect(server).not.toBe('')
    let worktreeId = ''
    await expect
      .poll(
        async () => {
          const listed = HostWorktreesSchema.safeParse(
            await result(socket, 'mobileRelay.hosts.worktrees', { hostId: server })
          )
          worktreeId =
            listed.data?.worktrees.find((row) => row.path === githubRepo)?.worktreeId ?? ''
          return worktreeId
        },
        { timeout: 30_000 }
      )
      .not.toBe('')
    const worktree = `id:${worktreeId}`

    // Open: the server's file, read on the server.
    const opened = z
      .looseObject({ content: z.string() })
      .parse(await result(socket, 'files.read', { worktree, relativePath: 'NOTES.md' }, server))
    expect(opened.content).toBe('changed on the server\n')

    // Upload: the slot lives in the server process, so the Mac knows nothing of it.
    const image = Buffer.from('server-upload').toString('base64')
    const { uploadId } = z
      .object({ uploadId: z.string() })
      .parse(
        await result(
          socket,
          'clipboard.startImageUpload',
          { expectedBase64Length: image.length },
          server
        )
      )
    const chunk = { uploadId, offset: 0, contentBase64: image }
    const onMac = await send(socket, 'clipboard.appendImageUploadChunk', chunk)
    expect(onMac.ok, 'the upload slot is not on the desktop').toBe(false)
    await result(socket, 'clipboard.appendImageUploadChunk', chunk, server)
    const uploaded = z
      .string()
      .parse(await result(socket, 'clipboard.commitImageUpload', { uploadId }, server))
    expect(existsSync(uploaded)).toBe(true)

    // Commit: lands in the server's repository.
    await result(socket, 'git.stage', { worktree, filePath: 'NOTES.md' }, server)
    expect(
      await result(socket, 'git.commit', { worktree, message: 'from the phone' }, server)
    ).toMatchObject({ success: true })
    expect(git('log', '-1', '--format=%s').trim()).toBe('from the phone')
    expect(git('status', '--porcelain').trim()).toBe('')

    // Review: provider calls run on the server's repository, as the desktop runs them.
    const { repos } = ReposSchema.parse(await result(socket, 'repo.list', {}, server))
    const repo = repos.find((row) => row.path === githubRepo)?.id ?? ''
    expect(await result(socket, 'github.repoSlug', { repo }, server)).toMatchObject({
      owner: 'acme',
      repo: 'server-github-repo'
    })
    const untargeted = await send(socket, 'github.repoSlug', { repo })
    expect(untargeted.ok, 'the desktop does not hold the server repo').toBe(false)
  } finally {
    await dispose()
  }
})
