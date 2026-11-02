// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { setRendererUiLanguage } from '@/i18n/i18n'
import { RepositoryIssueCommandSetting } from './RepositoryIssueCommandSetting'
import { RepositoryHookCommandSourceSetting } from './RepositoryHookPolicySettings'

function renderSettings(hasSharedIssueCommand: boolean): ReturnType<typeof render> {
  return render(
    <>
      <RepositoryIssueCommandSetting
        issueCommandDraft=""
        setIssueCommandDraft={() => {}}
        hasSharedIssueCommand={hasSharedIssueCommand}
        issueCommandSaveError={null}
        commitIssueCommand={async () => {}}
      />
      <RepositoryHookCommandSourceSetting
        searchQuery=""
        selectedPolicy="shared-only"
        yamlState="missing"
        yamlHooks={null}
        copiedTemplate={false}
        isAdvancedOpen
        onSelectPolicy={() => {}}
        onCopyTemplate={() => {}}
        onAdvancedOpenChange={() => {}}
      />
    </>
  )
}

afterEach(async () => {
  cleanup()
  await setRendererUiLanguage('en')
})

describe('Repository settings complete translation templates', () => {
  for (const language of ['en', 'ko'] as const) {
    it.each([false, true])(
      `preserves tokens and conditional defaults in ${language} (shared=%s)`,
      async (shared) => {
        await setRendererUiLanguage(language)
        const view = renderSettings(shared)
        const paragraphs = Array.from(view.container.querySelectorAll('p'))
        const issue = paragraphs.find(
          (p) => p.querySelector('code')?.textContent === '{{artifact_url}}'
        )
        expect(issue?.textContent).toContain('{{artifact_url}}')
        expect(issue?.textContent).not.toContain('<artifactUrl>')
        const defaultHelp = paragraphs.find(
          (p) => p.querySelector('code')?.textContent === 'orca.yaml'
        )
        if (language === 'ko') {
          expect(issue?.textContent).toContain('변수를 사용하세요.')
          expect(defaultHelp?.textContent?.includes('있는 경우')).toBe(!shared)
        } else {
          expect(defaultHelp?.textContent?.includes('when one exists')).toBe(!shared)
        }
        const sourceHelp = paragraphs.find((p) =>
          p.textContent?.includes(
            language === 'ko' ? '로컬 명령이 모두' : 'and local commands exist'
          )
        )
        expect(sourceHelp?.querySelector('code')?.textContent).toBe('orca.yaml')
      }
    )
  }
})
