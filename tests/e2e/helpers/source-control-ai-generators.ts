import type { Page } from '@stablyai/playwright-test'
import { writeFileSync } from 'node:fs'

async function setCustomGenerator(page: Page, scriptPath: string): Promise<void> {
  await page.evaluate(async (scriptPath) => {
    const store =
      window.__store ??
      (() => {
        throw new Error('window.__store is not available')
      })()
    const currentSettings = store.getState().settings
    if (!currentSettings) {
      throw new Error('Settings were not loaded')
    }
    await store.getState().updateSettings({
      activeRuntimeEnvironmentId: null,
      sourceControlAi: {
        enabled: true,
        agentId: 'custom' as const,
        selectedModelByAgent: {},
        selectedThinkingByModel: {},
        instructionsByOperation: {},
        actions: {},
        customAgentCommand: `node ${JSON.stringify(scriptPath)}`
      }
    })
  }, scriptPath)
}

// Echo the prompt’s linked issue to test renderer → IPC → metadata → template → agent stdin.
// emitPayload runs with the captured issue and must write the caller’s expected reply.
export function writeLinkedIssueEchoGenerator(scriptPath: string, emitPayload: string[]): void {
  writeFileSync(
    scriptPath,
    [
      'const chunks = []',
      "process.stdin.on('data', (chunk) => chunks.push(chunk))",
      "process.stdin.on('end', () => {",
      "  const prompt = Buffer.concat(chunks).toString('utf8')",
      // Capture the whole line: a zero-digit match would hide an unexpanded {linkedIssue} token as empty.
      '  const match = prompt.match(/ORCA_E2E_ISSUE=([^\\r\\n]*)/)',
      "  const issue = match ? match[1] || 'empty' : 'missing'",
      ...emitPayload,
      '})'
    ].join('\n')
  )
}

export async function installDelayedPrGenerator(
  page: Page,
  generatorScriptPath: string,
  callLogPath: string,
  base: string
): Promise<void> {
  writeFileSync(
    generatorScriptPath,
    [
      "const fs = require('fs')",
      `fs.appendFileSync(${JSON.stringify(callLogPath)}, 'start\\n')`,
      'setTimeout(() => {',
      '  console.log(JSON.stringify({',
      `    base: ${JSON.stringify(base)},`,
      "    title: 'Generated PR title after switch',",
      "    body: 'Generated PR body after switch',",
      '    draft: false',
      '  }))',
      `  fs.appendFileSync(${JSON.stringify(callLogPath)}, 'finish\\n')`,
      '}, 1500)'
    ].join('\n')
  )
  await setCustomGenerator(page, generatorScriptPath)
}

export async function installDelayedCommitMessageGenerator(
  page: Page,
  generatorScriptPath: string,
  callLogPath: string
): Promise<void> {
  writeFileSync(
    generatorScriptPath,
    [
      "const fs = require('fs')",
      `fs.appendFileSync(${JSON.stringify(callLogPath)}, 'start\\n')`,
      'setTimeout(() => {',
      "  console.log('Generated commit message after switch')",
      "  console.log('')",
      "  console.log('Generated from staged e2e-commit-message-generation.txt after switching worktrees')",
      `  fs.appendFileSync(${JSON.stringify(callLogPath)}, 'finish\\n')`,
      '}, 1500)'
    ].join('\n')
  )
  await setCustomGenerator(page, generatorScriptPath)
}
