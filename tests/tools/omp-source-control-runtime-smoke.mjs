import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { getCommitMessageAgentSpec } from '../../src/shared/commit-message-agent-spec.ts'
const reference = process.argv[2]
assert.ok(reference, 'Pass the read-only source checkout path')
const { parseArgs } = await import(
  pathToFileURL(join(resolve(reference), 'packages/coding-agent/src/cli/args.ts')).href
)
const spec = getCommitMessageAgentSpec('omp')
assert.ok(spec)
for (const model of ['default', 'provider/model']) {
  const args = spec.buildArgs({ prompt: 'Generated entirely from stdin', model })
  const parsed = parseArgs(args)
  assert.equal(parsed.print, true)
  assert.equal(parsed.noSession, true)
  assert.equal(parsed.noTools, true)
  assert.equal(parsed.noExtensions, true)
  assert.equal(parsed.noSkills, true)
  assert.equal(parsed.noRules, true)
  assert.equal(parsed.mode, 'text')
  assert.equal(parsed.model, model === 'default' ? undefined : model)
  assert.deepEqual(parsed.messages, [])
}
console.log(
  JSON.stringify({
    actualArgumentParser: true,
    promptDelivery: spec.promptDelivery,
    configDefault: true,
    explicitModel: true,
    modelCalls: 0
  })
)
