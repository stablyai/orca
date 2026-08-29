import { spawn } from 'node:child_process'

const count = Number(process.argv[2] ?? 3)
const intervalMs = Number(process.argv[3] ?? 400)
const lifetimeMs = Number(process.argv[4] ?? 120)
for (let index = 0; index < count; index += 1) {
  const child = spawn(
    process.execPath,
    ['-e', `setTimeout(()=>{}, ${lifetimeMs})`, `fixture-${index}`],
    {
      stdio: 'ignore',
      windowsHide: true
    }
  )
  child.unref()
  await new Promise((resolve) => setTimeout(resolve, intervalMs))
}
