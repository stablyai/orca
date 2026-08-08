// Issue #12164 payloads, emitted as plain agent-style stdout. No IME involved.
const PAYLOADS = [
  '프로젝트 브랜딩 이름 확정',
  'project branding name',
  '项目品牌名称确定',
  'проект бренд имя'
]

// Clear + home so every payload starts at column 0 on a known row.
process.stdout.write('\u001b[H\u001b[2J\u001b[3J')
for (const line of PAYLOADS) {
  process.stdout.write(`${line}\n`)
}
process.stdout.write('ISSUE_12164_EMIT_DONE\n')
