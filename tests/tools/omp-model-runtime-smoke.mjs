import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getPiAgentStatusExtensionSource } from '../../src/main/pi/agent-status-extension-source.ts'
const reference = process.argv[2]
if (!reference) {
  throw new Error('Pass a read-only oh-my-pi checkout path')
}
const { createAgentSession } = await import(
  pathToFileURL(resolve(reference, 'packages/coding-agent/src/sdk.ts')).href
)
const { Settings } = await import(
  pathToFileURL(resolve(reference, 'packages/coding-agent/src/config/settings.ts')).href
)
const { ModelRegistry } = await import(
  pathToFileURL(resolve(reference, 'packages/coding-agent/src/config/model-registry.ts')).href
)
const { AuthStorage } = await import(
  pathToFileURL(resolve(reference, 'packages/coding-agent/src/session/auth-storage.ts')).href
)
const { SessionManager } = await import(
  pathToFileURL(resolve(reference, 'packages/coding-agent/src/session/session-manager.ts')).href
)
const root = await mkdtemp(join(tmpdir(), 'orca-omp-model-'))
const posts = []
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    posts.push(await request.json())
    return new Response('ok')
  }
})
Object.assign(process.env, {
  ORCA_PANE_KEY: 'model-proof',
  ORCA_AGENT_LAUNCH_TOKEN: 'model-proof',
  ORCA_TAB_ID: 'model-proof',
  ORCA_WORKTREE_ID: 'model-proof',
  ORCA_AGENT_HOOK_PORT: String(server.port),
  ORCA_AGENT_HOOK_TOKEN: 'model-proof',
  ORCA_AGENT_HOOK_ENV: 'model-proof'
})
delete process.env.ORCA_PI_STATUS_OWNED
const authStorage = await AuthStorage.create(join(root, 'auth.db'))
authStorage.setRuntimeApiKey('anthropic', 'fake-no-network-proof-key')
const registry = new ModelRegistry(authStorage, join(root, 'models.yml'))
let session
try {
  const from = registry.find('anthropic', 'claude-sonnet-4-5')
  const to = registry.find('anthropic', 'claude-sonnet-4-6')
  if (!from || !to) {
    throw new Error('missing bundled models')
  }
  const extensionPath = join(root, 'orca-agent-status.ts')
  await writeFile(extensionPath, getPiAgentStatusExtensionSource('omp'))
  const result = await createAgentSession({
    cwd: root,
    agentDir: root,
    authStorage,
    modelRegistry: registry,
    model: from,
    sessionManager: SessionManager.inMemory(),
    settings: Settings.isolated(),
    toolNames: [],
    disableExtensionDiscovery: true,
    additionalExtensionPaths: [extensionPath]
  })
  session = result.session
  const command = result.extensionsResult.extensions
    .flatMap((extension) => [...extension.commands.entries()])
    .find(([name]) => name === 'orca-model')?.[1]
  const runner = session.extensionRunner
  if (!command || !runner) {
    throw new Error('generated command was not loaded')
  }
  runner.initialize(
    {
      setModel: async (model) => {
        if (!(await registry.getApiKey(model))) {
          return false
        }
        await session.setModel(model)
        return true
      }
    },
    {
      getModel: () => session.model,
      isIdle: () => !session.isStreaming,
      hasPendingMessages: () => false
    }
  )
  const before = `${session.model?.provider}/${session.model?.id}`
  await command.handler(`${to.provider}/${to.id}`, runner.createCommandContext())
  const after = `${session.model?.provider}/${session.model?.id}`
  if (after !== `${to.provider}/${to.id}` || session.messages.length !== 0) {
    throw new Error('model switch failed or generated messages')
  }
  for (let i = 0; i < 50 && posts.length === 0; i++) {
    await Bun.sleep(10)
  }
  if (
    !posts.some(
      (post) =>
        post.payload?.hook_event_name === 'model_select' &&
        post.payload?.model === after &&
        post.payload?.model_switch_command === 'orca-model'
    )
  ) {
    throw new Error('Missing model and capability HTTP report')
  }
  console.log(
    JSON.stringify(
      {
        before,
        after,
        modelTurns: 0,
        messages: session.messages.length,
        posts,
        scope:
          'Actual OMP SDK session, extension loader, registered generated Orca command and OMP setModel; runner actions bound as in OMP ExtensionUIController, synthetic credentials, no model generation'
      },
      null,
      2
    )
  )
} finally {
  await session?.dispose()
  authStorage.close()
  server.stop(true)
  await rm(root, { recursive: true, force: true })
}
