const { parseArgs } = require('node:util')

const PATH_OPTIONS = ['user-data', 'ready', 'output', 'project-root']

function parseRasterRunOptions(args) {
  const { values, tokens } = parseArgs({
    args,
    options: Object.fromEntries(PATH_OPTIONS.map((name) => [name, { type: 'string' }])),
    strict: true,
    allowPositionals: false,
    tokens: true
  })
  const seen = new Set()
  for (const token of tokens) {
    if (token.kind !== 'option') {
      continue
    }
    if (seen.has(token.name)) {
      throw new Error(`Duplicate option --${token.name}`)
    }
    seen.add(token.name)
  }
  for (const name of PATH_OPTIONS) {
    if (!values[name]?.trim() || values[name].includes('\0')) {
      throw new Error(`Missing or invalid path for --${name}`)
    }
  }
  return {
    userData: values['user-data'],
    readyFile: values.ready,
    output: values.output,
    projectRoot: values['project-root']
  }
}

module.exports = { parseRasterRunOptions }
