import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
assert.ok(process.argv[2], 'Pass a read-only OMP checkout path')
const orcaRoot = fileURLToPath(new URL('../../', import.meta.url))
const scratch = await mkdtemp(join(tmpdir(), 'orca-omp-root-reader-'))
const home = join(scratch, 'home')
const xdg = join(scratch, 'data')
process.env.HOME = home
process.env.USERPROFILE = home
process.env.XDG_CONFIG_HOME = join(scratch, 'config')
process.env.XDG_DATA_HOME = xdg
process.env.XDG_STATE_HOME = join(scratch, 'state')
process.env.XDG_CACHE_HOME = join(scratch, 'cache')
for (const key of [
  'OMP_CODING_AGENT_DIR',
  'PI_CODING_AGENT_DIR',
  'OMP_PROFILE',
  'PI_PROFILE',
  'PI_CONFIG_DIR',
  'PI_CONFIG_FILES'
]) {
  delete process.env[key]
}
const source = (root, file) => pathToFileURL(join(resolve(root), file)).href
const managers = []
try {
  await mkdir(join(home, '.omp', 'agent', 'sessions'), { recursive: true })
  await mkdir(join(xdg, 'omp', 'profiles', 'work'), { recursive: true })
  const upstream = await import(source(process.argv[2], 'packages/utils/src/dirs.ts'))
  const { SessionManager } = await import(
    source(process.argv[2], 'packages/coding-agent/src/session/session-manager.ts')
  )
  const { readNativeChatTranscript } = await import(
    source(orcaRoot, 'src/main/native-chat/transcript-reader.ts')
  )
  const { resolveSessionFilePath } = await import(
    source(orcaRoot, 'src/main/native-chat/session-file-resolver.ts')
  )
  const results = []
  for (const profile of ['', 'work']) {
    process.env.OMP_PROFILE = profile
    upstream.__resetDirsFromEnvForTests()
    const cwd = join(scratch, 'folder workspace')
    await mkdir(cwd, { recursive: true })
    const manager = SessionManager.create(cwd)
    managers.push(manager)
    manager.appendMessage({
      role: 'user',
      content: 'Verify migrated OMP transcript lookup',
      timestamp: Date.now()
    })
    await manager.ensureOnDisk()
    await manager.flush()
    const expectedRoot = join(xdg, 'omp', ...(profile ? ['profiles', profile] : []), 'sessions')
    assert.ok(manager.getSessionFile().startsWith(expectedRoot))
    assert.equal(
      await resolveSessionFilePath('omp', manager.getSessionId()),
      manager.getSessionFile()
    )
    const result = await readNativeChatTranscript('omp', manager.getSessionId())
    assert.ok(
      result.messages?.some((message) =>
        JSON.stringify(message).includes('Verify migrated OMP transcript lookup')
      )
    )
    results.push({
      profile: profile || 'default',
      storedInXdg: true,
      nativeReaderFoundById: true,
      decodedMessages: result.messages.length
    })
  }
  console.log(JSON.stringify({ results, modelCalls: 0, legacyDirectoryCoexists: true }))
} finally {
  for (const manager of managers) {
    await manager.close()
  }
  await rm(scratch, { recursive: true, force: true })
}
