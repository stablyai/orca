import { beforeEach, describe, expect, it } from 'vitest'

import { i18n, setRendererPluginLanguagePacks } from './i18n'

// Why: these sentences used to be a noun plus an English plural ending passed as an
// interpolation value, so Japanese, Korean and Chinese rendered a Latin "s" after the
// noun. Each is now a pair of whole sentences chosen by count; this guards what every
// bundled locale actually renders for one and for several.
const COUNT_SENTENCES: readonly (readonly [string, Record<string, string | number>])[] = [
  ['auto.components.GitHubItemDialog.reactionCount', { reaction: 'heart' }],
  ['auto.components.GitLabItemDialog.approvalsRemaining', {}],
  ['auto.components.TaskPage.labelCount', {}],
  ['auto.components.TaskPage.memberCount', {}],
  ['auto.components.terminal.pane.terminal.drop.handler.skippedSymlink', {}],
  ['auto.components.terminal.pane.terminal.drop.handler.uploadingFile', {}],
  ['auto.components.sidebar.WorktreeList.groupProjectsRemained', { remaining: 1 }],
  ['auto.components.sidebar.AddRemoteHostDialog.sshImportSynced', {}],
  ['auto.components.right.sidebar.SourceControl.discardFailed', {}],
  ['auto.components.right.sidebar.SourceControl.noteCount', {}],
  ['auto.components.right.sidebar.source.control.compare.summary.commitsAhead', { ref: 'main' }],
  ['auto.components.onboarding.IntegrationsStep.linearWorkspacesLinked', {}]
]

const LATIN_S_AFTER_CJK = /[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]\s?s(?![a-z])/i

function renderCountSentence(
  baseKey: string,
  count: number,
  values: Record<string, string | number>
): string {
  const key = `${baseKey}${count === 1 ? 'Singular' : 'Plural'}`
  return i18n.t(key, { ...values, count, defaultValue: '' })
}

describe('count sentences in the bundled locales', () => {
  beforeEach(async () => {
    setRendererPluginLanguagePacks([])
    await i18n.changeLanguage('en')
  })

  it.each(['es', 'fr', 'ja', 'ko', 'zh'])(
    '%s renders whole sentences for one and several',
    async (locale) => {
      await i18n.changeLanguage(locale)
      for (const [baseKey, values] of COUNT_SENTENCES) {
        for (const count of [1, 3]) {
          const text = renderCountSentence(baseKey, count, values)
          expect(text, `${baseKey} (${count})`).toContain(String(count))
          expect(text, `${baseKey} (${count})`).not.toContain('{{')
        }
      }
    }
  )

  it.each(['ja', 'ko', 'zh'])('%s gets no Latin plural ending on its nouns', async (locale) => {
    await i18n.changeLanguage(locale)
    for (const [baseKey, values] of COUNT_SENTENCES) {
      expect(renderCountSentence(baseKey, 3, values), baseKey).not.toMatch(LATIN_S_AFTER_CJK)
    }
  })

  // Why: these languages do not inflect for number, so a pair that differs carries an
  // English plural inside the sentence ("commit"/"commits").
  it.each(['ja', 'ko', 'zh'])('%s uses one sentence for one and several', async (locale) => {
    await i18n.changeLanguage(locale)
    for (const [baseKey, values] of COUNT_SENTENCES) {
      const options = { ...values, count: 3, defaultValue: '' }
      expect(i18n.t(`${baseKey}Plural`, options), baseKey).toBe(
        i18n.t(`${baseKey}Singular`, options)
      )
    }
  })
})
