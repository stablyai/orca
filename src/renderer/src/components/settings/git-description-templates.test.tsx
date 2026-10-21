// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { setRendererUiLanguage } from '@/i18n/i18n'
import { TooltipProvider } from '../ui/tooltip'
import { GitPane } from './GitPane'
import { AutoRenameBranchFromWorkSetting } from './AutoRenameBranchFromWorkSetting'

const settings = getDefaultSettings('/translation-audit')

afterEach(async () => {
  cleanup()
  await setRendererUiLanguage('en')
})

describe('Git settings complete translation templates', () => {
  it.each(['en', 'ko'] as const)(
    'keeps code tokens and the prompt popover in %s',
    async (language) => {
      await setRendererUiLanguage(language)
      const git = render(
        <TooltipProvider>
          <GitPane
            settings={settings}
            updateSettings={() => {}}
            writeSourceControlAiSettings={async () => {}}
            displayedGitUsername="audit"
          />
        </TooltipProvider>
      )
      const paragraph = Array.from(git.container.querySelectorAll('p')).find((p) =>
        p.textContent?.includes('git diff main...HEAD')
      )
      expect(
        Array.from(paragraph?.querySelectorAll('code') ?? []).map((code) => code.textContent)
      ).toEqual(['main', 'master', 'git diff main...HEAD'])
      expect(paragraph?.textContent).not.toContain('<mainBranch>')
      if (language === 'ko') {
        expect(paragraph?.textContent).toContain(
          '커밋되지 않은 변경 사항이나 로컬에만 있는 커밋이 있으면 Orca는 업데이트를 건너뜁니다.'
        )
      }
      cleanup()
      const prompt = render(
        <AutoRenameBranchFromWorkSetting
          settings={settings}
          updateSettings={() => {}}
          writeSourceControlAiSettings={async () => {}}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: language === 'ko' ? '고급' : 'Advanced' }))
      expect(
        Array.from(prompt.container.querySelectorAll('p code')).map((code) => code.textContent)
      ).toEqual([
        'Nautilus',
        '{basePrompt}',
        '{firstPrompt}',
        '{assistantMessage}',
        'fix-login-flow'
      ])
      fireEvent.click(
        screen.getByRole('button', {
          name: language === 'ko' ? '내장 브랜치 이름 프롬프트' : 'built-in branch-name prompt'
        })
      )
      await waitFor(() =>
        expect(document.querySelector('[data-slot="popover-content"] pre')?.textContent).toContain(
          'first agent prompt'
        )
      )
    }
  )
})
