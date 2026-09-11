import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
const piCli = process.argv[2] && resolve(process.argv[2])
assert.ok(piCli, 'Pass the installed Pi CLI entrypoint')
const scratch = await mkdtemp(join(tmpdir(), 'orca-pi-default-'))
const requests = []
const server = createServer(async (req, res) => {
  let body = ''
  for await (const part of req) {
    body += part
  }
  requests.push(JSON.parse(body))
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const chunk of [
    {
      id: 'proof',
      object: 'chat.completion.chunk',
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: 'fixture-generated-commit' },
          finish_reason: null
        }
      ]
    },
    {
      id: 'proof',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }
  ]) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  }
  res.end('data: [DONE]\n\n')
})
try {
  const bundle = join(scratch, 'orca.cjs')
  await build({
    stdin: {
      contents:
        "export {planCommitMessageGeneration} from './src/shared/commit-message-plan'; export {resolveSourceControlAiForOperation} from './src/shared/source-control-ai'; export {getDefaultSettings} from './src/shared/constants'; export {runProcess} from './src/shared/child-process/run-process';",
      resolveDir: process.cwd()
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle
  })
  const {
    planCommitMessageGeneration,
    runProcess,
    resolveSourceControlAiForOperation,
    getDefaultSettings
  } = createRequire(import.meta.url)(bundle)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const dir = join(scratch, 'agent')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'models.json'),
    JSON.stringify({
      providers: {
        'orca-proof': {
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
          apiKey: 'fixture-only',
          api: 'openai-completions',
          models: ['local', 'override'].map((id) => ({
            id,
            name: id,
            reasoning: false,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 256
          }))
        }
      }
    })
  )
  await writeFile(
    join(dir, 'settings.json'),
    JSON.stringify({ defaultProvider: 'orca-proof', defaultModel: 'local' })
  )
  const settings = process.argv[3]
    ? JSON.parse(await readFile(resolve(process.argv[3]), 'utf8')).settings
    : getDefaultSettings(scratch)
  settings.defaultTuiAgent = 'pi'
  settings.sourceControlAi.agentId = 'pi'
  settings.commitMessageAi.agentId = 'pi'
  function planOperation(operation) {
    const resolved = resolveSourceControlAiForOperation({
      settings,
      operation,
      discoveryHostKey: 'local'
    })
    assert.equal(resolved.ok, true)
    assert.equal(resolved.value.params.useConfiguredDefaultModel, true)
    return planCommitMessageGeneration(resolved.value.params, 'Generate one short commit message.')
  }
  const planned = planOperation('branchName')
  assert.equal(planned.ok, true)
  const fixedArgs = planned.plan.args
  assert.ok(!fixedArgs.includes('--model'))
  const variants = [
    ['baseline', [...fixedArgs, '--model', 'github-copilot/gpt-5.4-mini']],
    ['branch-name-configured-default', fixedArgs],
    [
      'explicit-override',
      planCommitMessageGeneration(
        { agentId: 'pi', model: 'orca-proof/override' },
        'Generate one short commit message.'
      ).plan.args
    ]
  ]
  variants.push(
    ['commit-message-configured-default', planOperation('commitMessage').plan.args],
    ['pull-request-configured-default', planOperation('pullRequest').plan.args]
  )
  const results = []
  for (const [variant, args] of variants) {
    const n = requests.length
    const result = await runProcess({
      program: process.execPath,
      args: [piCli, ...args],
      cwd: scratch,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        HOME: scratch,
        USERPROFILE: scratch,
        ORCA_BACKGROUND_LAUNCH: '1',
        PI_CODING_AGENT_DIR: dir
      },
      input: planned.plan.stdinPayload,
      timeoutMs: 20000
    })
    results.push({
      variant,
      args,
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      requests: requests.length - n,
      model: requests.at(-1)?.model
    })
  }
  assert.equal(results[0].requests, 0)
  assert.notEqual(results[0].code, 0)
  assert.equal(results[1].code, 0, results[1].stderr)
  assert.match(results[1].stdout, /fixture-generated-commit/)
  assert.equal(results[1].requests, 1)
  assert.equal(results[1].model, 'local')
  assert.equal(results[2].code, 0, results[2].stderr)
  assert.equal(results[2].model, 'override')
  assert.equal(results[2].requests, 1)
  for (const result of results.slice(3)) {
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.requests, 1)
    assert.equal(result.model, 'local')
  }
  console.log(
    JSON.stringify(
      {
        scope:
          'Actual Pi CLI, source-control operation resolver (including first-work branchName), and production command planner; isolated models.json provider with local OpenAI-compatible fixture.',
        platform: process.platform,
        results
      },
      null,
      2
    )
  )
} finally {
  server.closeAllConnections()
  server.close()
  await rm(scratch, { recursive: true, force: true })
}
