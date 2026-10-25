import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { PNG } from 'pngjs'

function image(first: number[], second: number[]): Buffer {
  const png = new PNG({ width: 120, height: 60 })
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      png.data.set(x < 60 ? first : second, (y * png.width + x) * 4)
    }
  }
  return PNG.sync.write(png)
}

export function createClaudePluginImageFixture(
  root: string,
  command: string,
  force: boolean | 'managed'
) {
  const cwd = join(root, 'cwd')
  const config = join(root, 'config')
  const plugin = join(root, 'plugin')
  for (const directory of [cwd, config, join(plugin, '.claude-plugin'), join(plugin, 'hooks')]) {
    mkdirSync(directory, { recursive: true })
  }
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'orca-claude-image-acceptance-'))
  const file = join(temporaryRoot, 'synthetic.png')
  writeFileSync(file, image([40, 240, 40, 255], [240, 200, 40, 255]))
  const png = image([240, 40, 40, 255], [40, 80, 240, 255]).toString('base64')
  writeFileSync(
    join(config, '.claude.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      theme: 'dark',
      projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } }
    })
  )
  writeFileSync(
    join(plugin, '.claude-plugin', 'plugin.json'),
    JSON.stringify({
      name: 'orca-image-acceptance',
      version: '0.1.0',
      description: 'Session-only terminal image acceptance fixture',
      author: { name: 'Orca contributors' }
    })
  )
  writeFileSync(join(plugin, 'hooks', 'hooks.json'), '{"modules":["./register.js"]}')
  writeFileSync(
    join(plugin, 'hooks', 'register.js'),
    `let stage = 'bytes'
export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.command.register({name:'image-acceptance', description:'Select bytes, file or clear'})
    return next(e)
  })
  on('command.run', {command:'image-acceptance'}, async ($, e) => {
    stage = e.args.trim() || 'bytes'
    $.ui.invalidate('ui.render')
    return {text:'IMAGE_ACCEPTANCE_STAGE_' + stage}
  })
  on('ui.render', {component:'AbovePrompt'}, async ($, e, next) => {
    if(e.surface !== 'terminal' || stage === 'clear') return next(e)
    const {Box, Image, Text} = $.ui.resolve(e)
    return Box({flexDirection:'column',children:[
      Text({children:['IMAGE_ACCEPTANCE_' + stage]}),
      Image({source:stage === 'file' ? {file:${JSON.stringify(file)},format:'png'} : {png:${JSON.stringify(png)}},columns:12,rows:6,alt:'SYNTHETIC_IMAGE_FALLBACK'}),
      await next(e)
    ]})
  })
}
`
  )
  const launcher = join(root, 'launch-claude.cjs')
  writeFileSync(
    launcher,
    `const {spawnProcess}=require(${JSON.stringify(createRequire(join(process.cwd(), 'package.json')).resolve('@orca/process-host'))});
const env={...process.env,CLAUDE_CONFIG_DIR:${JSON.stringify(config)},CLAUDE_CODE_TMPDIR:${JSON.stringify(join(temporaryRoot, 'cli-cache'))},CLAUDE_CODE_ENABLE_FUNCTION_HOOKS:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1',COLORTERM:'truecolor'};
for(const key of ['NO_COLOR','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','CLAUDECODE','CLAUDE_CODE_ENTRYPOINT','CLAUDE_CODE_SESSION_ID','CLAUDE_CODE_CHILD_SESSION','CLAUDE_CODE_SESSION_KIND']) delete env[key];
${force === true ? "env.CLAUDE_CODE_FORCE_TERMINAL_IMAGES='1';" : force === false ? 'delete env.CLAUDE_CODE_FORCE_TERMINAL_IMAGES;' : ''}
require('node:fs').writeFileSync(${JSON.stringify(join(root, 'gate.json'))},JSON.stringify({flag:env.CLAUDE_CODE_FORCE_TERMINAL_IMAGES??null}));
const child=spawnProcess({program:${JSON.stringify(command)},args:['--plugin-dir',${JSON.stringify(plugin)},'--setting-sources','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}'],cwd:${JSON.stringify(cwd)},env,stdio:'inherit'});
child.on('error',()=>{console.error('CLAUDE_IMAGE_ACCEPTANCE_LAUNCH_FAILED');process.exitCode=1});
child.on('exit',code=>{console.log('CLAUDE_IMAGE_ACCEPTANCE_EXIT');process.exitCode=code??0});
process.on('SIGTERM',()=>child.kill('SIGTERM'));
`
  )
  return {
    launcher,
    plugin,
    gateReceipt: join(root, 'gate.json'),
    cleanup: () => rmSync(temporaryRoot, { recursive: true, force: true })
  }
}
