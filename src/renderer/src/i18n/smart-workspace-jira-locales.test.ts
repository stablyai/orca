import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import es from './locales/es.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import zh from './locales/zh.json'

const localizedCatalogs = { es, ja, ko, zh }
const english = en.auto.components.new.workspace.SmartWorkspaceNameField
const recoveryKeys = [
  'loadingJira',
  'jiraDisconnected',
  'jiraSiteNotConnected',
  'jiraRuntimeUpdate',
  'jiraReadFailed',
  'chooseJiraAccount',
  'jiraLoaded',
  'openSettings',
  'retryJira'
] as const

describe('smart workspace Jira locale copy', () => {
  it.each(Object.entries(localizedCatalogs))(
    '%s localizes every Jira status and recovery string',
    (_code, catalog) => {
      const localized = catalog.auto.components.new.workspace.SmartWorkspaceNameField
      for (const key of recoveryKeys) {
        expect(localized[key].trim()).not.toBe('')
        expect(localized[key]).not.toBe(english[key])
      }
    }
  )
})
