import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

const keyword = translateSearchKeyword

export const getGeneralDebuggerSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('debug.settings.title', 'Debuggers'),
    description: translate(
      'debug.settings.description',
      'Debug adapters run only for projects you allow, from binaries you approve.'
    ),
    keywords: [
      ...keyword('debug.settings.title', 'Debuggers', { aliases: ['dap', 'debug adapter'] }),
      ...keyword('debug.settings.allowDebugging', 'Allow debugging'),
      ...keyword('debug.settings.adapters', 'Debug Adapters'),
      ...keyword('debug.settings.launchApprovals', 'Approved Launch Configurations', {
        aliases: ['launch.json']
      })
    ]
  },
  {
    title: translate('debug.settings.pythonPath', 'Python for debugpy'),
    keywords: keyword('debug.settings.pythonPath', 'Python for debugpy', {
      aliases: ['python', 'debugpy', 'interpreter']
    })
  },
  {
    title: translate('debug.settings.jsDebugPath', 'js-debug Server'),
    keywords: keyword('debug.settings.jsDebugPath', 'js-debug Server', {
      aliases: ['javascript', 'node', 'dapDebugServer.js']
    })
  }
])
