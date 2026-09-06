import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const file = path.join(path.dirname(require.resolve('playwright-core/package.json')), 'lib/server/chromium/crExecutionContext.js')
let source = fs.readFileSync(file, 'utf8')
const needle = 'function rewriteError(error) {'
if (!source.includes(needle)) throw new Error('Playwright diagnostic hook missing')
source = source.replace(needle, needle + '\n  console.error("[raw-context-error]", error.message, error.stack);')
fs.writeFileSync(file, source)
