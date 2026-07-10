import { execFileSync } from 'node:child_process'
import type { DockerSshRelayTarget } from './helpers/docker-ssh-relay-target'

const REMOTE_TUI_PATH = '/tmp/orca-codex-display-artifacts-repro.mjs'
export const REMOTE_TUI_DONE = 'ORCA_REMOTE_CODEX_ARTIFACT_TUI_DONE'
export const REMOTE_CODEX_FIXTURE_CLEAN_FINAL_TEXT =
  'Any gray slab visible now is stale renderer state.'
const REMOTE_TUI_FRAMES = 900
const REMOTE_CODEX_FIXTURE_FRAMES = parseEnvNumber(process.env.ORCA_E2E_CODEX_FIXTURE_FRAMES, 34)
const REMOTE_CODEX_FIXTURE_FRAME_DELAY_MS = parseEnvNumber(
  process.env.ORCA_E2E_CODEX_FIXTURE_FRAME_DELAY_MS,
  45
)

function parseEnvNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function remoteCodexArtifactTuiScript(): string {
  return `
const cols = Number(process.env.COLUMNS || 120)
const statusWidth = Math.max(48, Math.min(cols - 4, 104))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function write(chunk) {
  return new Promise((resolve) => process.stdout.write(chunk, resolve))
}

function pad(text, width) {
  const raw = text.length > width ? text.slice(0, width) : text
  return raw + ' '.repeat(Math.max(0, width - raw.length))
}

await write('\\x1b]0;codex\\x07')
await write('\\x1b[2J\\x1b[H\\x1b[?25l')

for (let frame = 0; frame < ${REMOTE_TUI_FRAMES}; frame += 1) {
  const statusRow = 8 + (frame % 13)
  const priorRow = 8 + ((frame + 12) % 13)
  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'][frame % 8]
  const bands = [
    { row: statusRow, width: statusWidth, text: \`\${spinner} Working for background terminal · frame \${String(frame).padStart(3, '0')}\` },
    { row: 27 + (frame % 9), width: Math.max(32, statusWidth - 18), text: \`gpt-5.5 high · ~/remote/repro/pr-5969 · /ps to view · /stop to close \${frame}\` },
    { row: 40 + (frame % 11), width: Math.max(28, statusWidth - 8), text: \`• Working for background terminal · rtk bun run e2e:ui --filter=@dalp/app \${frame}\` }
  ]
  await write('\\x1b[?2026h')
  await write(\`\\x1b[\${priorRow};1H\\x1b[2K\`)
  await write(\`\\x1b[\${27 + ((frame + 8) % 9)};1H\\x1b[2K\`)
  await write(\`\\x1b[\${40 + ((frame + 10) % 11)};1H\\x1b[2K\`)
  await write('\\x1b[1;1H\\x1b[38;2;142;196;255mgpt-5.5 high\\x1b[0m ')
  await write('\\x1b[38;2;106;176;76m~/remote/repro/pr-5969\\x1b[0m ')
  await write('/ps to view · /stop to close')
  await write('\\x1b[3;1H• Reproducing remote Codex SSH display artifacts with fast status movement')
  await write('\\x1b[4;1H• The moving status band intentionally uses gray background during frames')
  await write('\\x1b[5;1H• Final screen is clean; any remaining gray slab is stale renderer state')
  for (const band of bands) {
    await write(\`\\x1b[\${band.row};1H\\x1b[48;2;72;72;72m\${pad('', band.width)}\\x1b[0m\`)
    await write(\`\\x1b[\${band.row};3H\\x1b[38;2;220;220;220;48;2;72;72;72m\${pad(band.text, band.width - 4)}\\x1b[0m\`)
  }
  await write(\`\\x1b[22;1H\\x1b[38;2;106;176;76m+\${' added code '.repeat(8)}\${frame}\\x1b[0m\`)
  await write(\`\\x1b[23;1H\\x1b[38;2;230;90;75m-\${' removed code '.repeat(8)}\${frame}\\x1b[0m\`)
  await write(\`\\x1b[25;1H\\x1b[38;2;153;199;255m› \${'Run focused and full validation gates '.repeat(3)}\${frame}\\x1b[0m\`)
  if (frame % 18 === 0) {
    await write(\`\\x1b[52;1H\\x1b[0m• Waited for background terminal · rtk bun run e2e:ui --filter=@dalp/app \${frame}\\r\\n\`)
  }
  await write('\\x1b[?2026l')
  await sleep(8)
}

await write('\\x1b[?2026h\\x1b[2J\\x1b[H')
await write('\\x1b[38;2;142;196;255mgpt-5.5 high\\x1b[0m ')
await write('\\x1b[38;2;106;176;76m~/remote/repro/pr-5969\\x1b[0m clean final frame\\r\\n\\r\\n')
await write('Final screen intentionally has no gray background bands.\\r\\n')
await write('If Orca leaves wide gray rectangles here, they are stale remote-PTY render artifacts.\\r\\n')
await write('${REMOTE_TUI_DONE}\\r\\n')
await write('\\x1b[?25h\\x1b[?2026l')
setTimeout(() => process.exit(0), 50)
`
}

export function installRemoteCodexArtifactTui(target: DockerSshRelayTarget): void {
  const body = remoteCodexArtifactTuiScript()
  dockerWriteFile(target, REMOTE_TUI_PATH, body, '755')
}

function remoteCodexFixtureScript(): string {
  return `#!/usr/bin/env node
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const write = (chunk) => new Promise((resolve) => process.stdout.write(chunk, resolve))
const cols = Number(process.env.COLUMNS || 120)
const rows = Number(process.env.LINES || 48)
const width = Math.max(42, cols - 4)
const marker = process.argv.join(' ').match(/ORCA_REMOTE_CODEX_ARTIFACT_TUI_DONE|ORCA_REAL_REMOTE_CODEX_DONE_[0-9]+/)?.[0] || '${REMOTE_TUI_DONE}'
const scrollTop = 1
const viewportTop = Math.max(14, rows - 17)
const viewportBottom = Math.max(viewportTop + 8, rows - 3)

function pad(text, size) {
  const raw = text.length > size ? text.slice(0, size) : text
  return raw + ' '.repeat(Math.max(0, size - raw.length))
}

async function grayLine(row, text) {
  await write(\`\\x1b[\${row};1H\\x1b[48;2;72;72;72m\${pad('', width)}\\x1b[0m\`)
  await write(\`\\x1b[\${row};3H\\x1b[38;2;220;220;220;48;2;72;72;72m\${pad(text, width - 4)}\\x1b[0m\`)
}

async function grayScrollLine(text) {
  await write(\`\\x1b[48;2;72;72;72m\${pad(text, width)}\\x1b[0m\\r\\n\`)
}

async function codexViewportFrame(frame) {
  await write('\\x1b[?2026h')
  await write('\\x1b[?25l')
  await write(\`\\x1b[\${viewportTop};1H\\x1b[2K\\x1b[38;2;142;196;255m>_ OpenAI Codex\\x1b[0m  \`)
  await write('\\x1b[38;2;106;176;76mgpt-5.5 high\\x1b[0m  ')
  await write('\\x1b[38;2;180;180;180m/model to change · /ps to view · /stop to close\\x1b[0m')
  await grayLine(viewportTop + 2 + (frame % 5), \`• Working for background terminal · rtk bun run e2e:ui --filter=@dalp/app \${frame}\`)
  await write(\`\\x1b[\${viewportTop + 8};1H\\x1b[2K\\x1b[38;2;153;199;255m› \${pad('Reviewing terminal renderer state after remote SSH output burst ' + frame, width - 4)}\\x1b[0m\`)
  await write('\\x1b[?2026l')
}

async function insertCodexHistory(frame) {
  const historyTop = scrollTop
  const historyBottom = Math.max(historyTop + 3, viewportTop - 1)
  const cursorTop = Math.max(historyTop, historyBottom - 1)
  await write(\`\\x1b[\${historyTop};\${historyBottom}r\`)
  await write(\`\\x1b[\${cursorTop};1H\`)
  for (let index = 0; index < 3; index += 1) {
    const phase = String(frame).padStart(4, '0') + '.' + index
    await write('\\r\\n')
    await write(\`\\x1b[48;2;72;72;72m\\x1b[K\`)
    await write(\`\\x1b[38;2;220;220;220;48;2;72;72;72m\${pad('gpt-5.5 high · ~/code/pr-12250-migration-compare-move-baseprice-claim · /ps to view · /stop to close ' + phase, width)}\\x1b[0m\`)
  }
  await write('\\x1b[r')
  await write(\`\\x1b[\${viewportBottom};1H\`)
}

async function reverseIndexCodexHistory(frame) {
  const historyTop = scrollTop
  const historyBottom = Math.max(historyTop + 4, viewportTop - 1)
  const scrollAmount = 2 + (frame % 3)
  await write(\`\\x1b[\${historyTop};\${rows}r\`)
  await write(\`\\x1b[\${viewportTop};1H\`)
  for (let index = 0; index < scrollAmount; index += 1) {
    await write('\\x1bM')
  }
  await write('\\x1b[r')
  await write(\`\\x1b[\${historyTop};\${historyBottom}r\`)
  await write(\`\\x1b[\${historyBottom};1H\`)
  for (let index = 0; index < scrollAmount; index += 1) {
    await write('\\r\\n')
    await write(\`\\x1b[48;2;72;72;72m\\x1b[K\\x1b[38;2;220;220;220;48;2;72;72;72m\${pad('• Waited for background terminal · rtk bun run e2e:ui --filter=@dalp/app ' + frame + ':' + index, width)}\\x1b[0m\`)
  }
  await write('\\x1b[r')
  await write(\`\\x1b[\${viewportBottom};1H\`)
}

await write('\\x1b]0;codex\\x07')
await write('\\x1b[?25l')
await write('>_ OpenAI Codex (fixture)\\r\\n')
await write('model:     gpt-5.5  /model to change\\r\\n')
await write('directory: ' + process.cwd() + '\\r\\n')
await write('permissions: YOLO mode\\r\\n\\r\\n')
await write('Tip: deterministic fixture for Orca SSH Codex display artifacts.\\r\\n\\r\\n')

for (let frame = 0; frame < ${REMOTE_CODEX_FIXTURE_FRAMES}; frame += 1) {
  await codexViewportFrame(frame)
  await insertCodexHistory(frame)
  if (frame % 4 === 0) {
    await reverseIndexCodexHistory(frame)
  }
  if (frame % 9 === 0) {
    await grayScrollLine(\`gpt-5.5 high · ~/code/pr-12250-migration-compare-move-baseprice-claim · /ps to view · /stop to close \${frame}\`)
  }
  await sleep(${REMOTE_CODEX_FIXTURE_FRAME_DELAY_MS})
}

await write('Updated Plan\\r\\n')
await write('  ✓ Reproduce remote Codex SSH display artifact\\r\\n')
await write('  ✓ Capture repeated gray status bands in scrollback\\r\\n')
await write('\\x1b[r\\x1b[?2026h\\x1b[2J\\x1b[H')
await write('Clean final frame after Codex-style gray status redraws.\\r\\n')
await write('There should be no gray background bands on this screen.\\r\\n')
await write('${REMOTE_CODEX_FIXTURE_CLEAN_FINAL_TEXT}\\r\\n')
await write(marker + '\\r\\n')
await write('\\x1b[?25h\\x1b[?2026l')
`
}

export function installRemoteCodexFixture(target: DockerSshRelayTarget): void {
  dockerWriteFile(target, '/usr/local/bin/codex', remoteCodexFixtureScript(), '755')
}

export function dockerExec(
  target: DockerSshRelayTarget,
  command: string,
  timeoutMs = 60_000
): void {
  execFileSync('docker', ['exec', target.containerName, 'bash', '-lc', command], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs
  })
}

export function dockerWriteFile(
  target: DockerSshRelayTarget,
  remotePath: string,
  body: string | Uint8Array,
  mode: string
): void {
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      target.containerName,
      'bash',
      '-lc',
      `cat > ${shellQuote(remotePath)} && chmod ${shellQuote(mode)} ${shellQuote(remotePath)}`
    ],
    {
      input: body,
      stdio: ['pipe', 'ignore', 'pipe'],
      timeout: 60_000
    }
  )
}
