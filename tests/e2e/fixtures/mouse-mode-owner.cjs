const fs = require('node:fs')

const [pidFile, inputFile, screen = 'alt', title = 'Claude Code'] = process.argv.slice(2)
fs.writeFileSync(pidFile, String(process.pid))
process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdout.write(
  `${screen === 'alt' ? '\x1b[?1049h' : ''}${title === 'none' ? '' : `\x1b]0;${title}\x07`}\x1b[?1003h\x1b[?1006h\x1b[?1004h\r\nORCA_MOUSE_OWNER_READY\r\n`
)
process.stdin.on('data', (data) => {
  fs.appendFileSync(inputFile, `${JSON.stringify(data)}\n`)
  if (data.includes('\x1b[<')) {
    process.stdout.write('ORCA_MOUSE_REPORT_RECEIVED\r\n')
  }
})
process.stdin.resume()
