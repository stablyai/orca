export function remoteTypingLoadScript(runId: string): string {
  return [
    "process.stdin.setEncoding('utf8')",
    'if (process.stdin.isTTY) process.stdin.setRawMode(true)',
    'process.stdin.resume()',
    'const statusRow = Math.max(2, process.stdout.rows || 24)',
    "process.stdout.write('\\x1b[1;' + (statusRow - 1) + 'r')",
    'let seq = 0',
    'let frame = 0',
    'let bg = null',
    `process.stdout.write('REMOTE_TUI_READY_${runId}\\n')`,
    "setTimeout(() => { bg = setInterval(() => { frame += 1; process.stdout.write('\\x1b[1;1HBG_' + frame + '_' + 'x'.repeat(4096) + '\\n') }, 8) }, 500)",
    "process.stdin.on('data', (chunk) => {",
    '  if (chunk.includes(String.fromCharCode(3))) { if (bg) clearInterval(bg); process.exit(0) }',
    '  for (const char of chunk) {',
    "    if (char === '\\r' || char === '\\n') continue",
    '    seq += 1',
    `    process.stdout.write('\\x1b[' + statusRow + ';2H\\x1b[2KKEY_${runId}_' + seq + '_' + char)`,
    '  }',
    '})'
  ].join(';')
}
