import { orcaCliInvocations } from './orca-cli-invocations'

/** The browser CLI's command keys per handler group. Kept apart from the CLI's
 *  lazy handler imports so the renderer and mobile can read them too. */
export const ORCA_BROWSER_CLI_COMMAND_KEYS = {
  'browser-identity': ['browser identity get', 'browser identity set'],
  'browser-nav': [
    'snapshot',
    'screenshot',
    'goto',
    'back',
    'reload',
    'forward',
    'eval',
    'scroll',
    'wait',
    'pdf',
    'full-screenshot'
  ],
  'browser-interact': [
    'click',
    'dblclick',
    'fill',
    'type',
    'select',
    'check',
    'uncheck',
    'focus',
    'clear',
    'select-all',
    'keypress',
    'hover',
    'drag',
    'upload',
    'scrollintoview',
    'get',
    'is',
    'inserttext',
    'mouse move',
    'mouse down',
    'mouse up',
    'mouse wheel',
    'find',
    'download',
    'highlight'
  ],
  'browser-tab': [
    'open-url',
    'tab list',
    'tab show',
    'tab current',
    'tab switch',
    'tab create',
    'tab close',
    'exec'
  ],
  'browser-profile': [
    'tab profile list',
    'tab profile create',
    'tab profile delete',
    'tab profile set',
    'tab profile show',
    'tab profile use-default',
    'tab profile clone'
  ],
  'browser-cookie': ['cookie get', 'cookie set', 'cookie delete'],
  'browser-capture': [
    'intercept enable',
    'intercept disable',
    'intercept list',
    'capture start',
    'capture stop',
    'console',
    'network'
  ],
  'browser-env': [
    'viewport',
    'geolocation',
    'set device',
    'set offline',
    'set headers',
    'set credentials',
    'set media',
    'clipboard read',
    'clipboard write',
    'dialog accept',
    'dialog dismiss'
  ],
  'browser-storage': [
    'storage local get',
    'storage local set',
    'storage local clear',
    'storage session get',
    'storage session set',
    'storage session clear'
  ]
} as const satisfies Record<string, readonly string[]>

const BROWSER_COMMAND_WORDS = new Set<string>(
  Object.values(ORCA_BROWSER_CLI_COMMAND_KEYS).flatMap((keys) =>
    keys.map((key) => key.split(' ')[0])
  )
)

export type OrcaBrowserCommand = { pageId: string | null }

/** The first `orca <browser command>` a shell command line runs, with the page it
 *  targets, or null when it runs none. Quoted text is an argument, never a command. */
export function parseOrcaBrowserCommand(command: string): OrcaBrowserCommand | null {
  const args = orcaCliInvocations(command).find((invocation) =>
    BROWSER_COMMAND_WORDS.has(invocation[0] ?? '')
  )
  return args ? { pageId: pageFlagValue(args.slice(1)) } : null
}

function pageFlagValue(args: readonly string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--page') {
      return args[index + 1] || null
    }
    if (arg.startsWith('--page=')) {
      return arg.slice('--page='.length) || null
    }
  }
  return null
}
