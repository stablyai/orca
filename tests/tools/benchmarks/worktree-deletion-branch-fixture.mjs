import { spawnSync } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'

function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.status})\n${result.stderr}`)
  }
  return result.stdout.trim()
}

export function initializeBranchCleanupRemote(fixtureRoot, repoPath) {
  const remotePath = path.join(fixtureRoot, 'remote.git')
  runGit(['init', '--bare', remotePath], fixtureRoot)
  runGit(['symbolic-ref', 'HEAD', 'refs/heads/main'], remotePath)
  runGit(['remote', 'add', 'origin', remotePath], repoPath)
  runGit(['push', 'origin', 'main'], repoPath)
}

export function seedBranchCleanupRepro(repoPath, worktreePath) {
  runGit(
    ['commit', '--allow-empty', '-m', 'Trigger safe branch cleanup', '--no-gpg-sign'],
    worktreePath
  )
  const branch = runGit(['symbolic-ref', '--short', 'HEAD'], worktreePath)
  runGit(['config', `branch.${branch}.base`, 'refs/remotes/origin/main'], repoPath)
}

export async function startDelayedFetchServer(delayMs) {
  const sockets = new Set()
  const timers = new Set()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    const timer = setTimeout(() => {
      timers.delete(timer)
      socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n')
    }, delayMs)
    timers.add(timer)
    socket.on('close', () => {
      clearTimeout(timer)
      timers.delete(timer)
      sockets.delete(socket)
    })
    socket.on('error', () => undefined)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Delayed fetch server did not expose a TCP port')
  }
  return {
    url: `http://127.0.0.1:${address.port}/remote.git`,
    close: () =>
      new Promise((resolve) => {
        for (const timer of timers) {
          clearTimeout(timer)
        }
        timers.clear()
        for (const socket of sockets) {
          socket.destroy()
        }
        server.close(resolve)
      })
  }
}
