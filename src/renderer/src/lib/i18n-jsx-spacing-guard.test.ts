import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guard against the i18n fragment glue-word class of bugs:
 * `translate('…', 'word')}` immediately followed by `<code>` / `{value}` without
 * an explicit `{' '}` space. Newline indentation alone is not reliable.
 */
const ROOT = path.resolve(__dirname, '..')

type GuardCase = {
  file: string
  /** English fallback that must be followed by `{' '}` before the next token. */
  afterFallback: string
  /** Human-readable description for assertion messages. */
  label: string
}

const CASES: GuardCase[] = [
  {
    file: 'components/sidebar/SetupScriptPromptCardViews.tsx',
    afterFallback: 'This repo ignores shared',
    label: 'shared orca.yaml'
  },
  {
    file: 'components/sidebar/SetupScriptPromptCardViews.tsx',
    afterFallback: 'Detected from',
    label: 'Detected from provenance'
  },
  {
    file: 'components/sidebar/SetupScriptPromptCardViews.tsx',
    afterFallback: 'Found a setup command in',
    label: 'Found a setup command in source'
  },
  {
    file: 'components/settings/RepositoryHooksSection.tsx',
    afterFallback: 'Example',
    label: 'Example orca.yaml template'
  },
  {
    file: 'components/settings/RepositoryHooksSection.tsx',
    afterFallback: 'Edit',
    label: 'Edit orca.yaml'
  },
  {
    file: 'components/settings/RepositoryHooksSection.tsx',
    afterFallback: 'When both',
    label: 'When both orca.yaml'
  },
  {
    file: 'components/settings/GitPane.tsx',
    afterFallback: 'or',
    label: 'main or master'
  },
  {
    file: 'components/settings/GitPane.tsx',
    afterFallback: 'such as',
    label: 'such as main'
  },
  {
    file: 'components/settings/RuntimeEnvironmentsPane.tsx',
    afterFallback: 'Run',
    label: 'Run orca serve'
  },
  {
    file: 'components/settings/AutoRenameBranchFromWorkSetting.tsx',
    afterFallback: 'Use',
    label: 'Use {basePrompt}'
  },
  {
    file: 'components/settings/CommitMessageAiPane.tsx',
    afterFallback: 'Use',
    label: 'Use {prompt}'
  },
  {
    file: 'components/editor/RichMarkdownDocLinkMenu.tsx',
    afterFallback: 'Showing',
    label: 'Showing N of M'
  },
  {
    file: 'components/editor/RichMarkdownDocLinkMenu.tsx',
    afterFallback: 'of',
    label: 'of totalMatches'
  },
  {
    file: 'components/contextual-tours/ContextualTourProgressDots.tsx',
    afterFallback: 'of',
    label: 'tour of total'
  },
  {
    file: 'components/github/PRFilterSections.tsx',
    afterFallback: 'Filter',
    label: 'Filter pull requests'
  },
  {
    file: 'components/editor/ConflictComponents.tsx',
    afterFallback: 'Renamed from',
    label: 'Renamed from path'
  },
  {
    file: 'components/settings/SshPassphraseDialog.tsx',
    afterFallback: 'Enter the password for',
    label: 'password for host'
  },
  {
    file: 'components/settings/ManageSessionKillDialog.tsx',
    afterFallback: 'Force-quits',
    label: 'Force-quits session id'
  },
  {
    file: 'components/sidebar/DeleteWorktreeWarningPanels.tsx',
    afterFallback: 'This is the',
    label: 'This is the main worktree'
  }
]

function hasExplicitSpaceAfterFallback(source: string, fallback: string): boolean {
  // Match translate fallbacks that end with (or equal) the given phrase, then
  // require an explicit {' '} after the closing )} so JSX whitespace is not
  // left to indentation alone.
  const escaped = fallback.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(
    String.raw`translate\(\s*'[^']+',\s*(?:'[^']*${escaped}'|"[^"]*${escaped}")\s*(?:,\s*\{[^}]*\})?\s*\)\s*\}\s*\{\s*['"]\s['"]\s*\}`,
    'm'
  )
  return pattern.test(source)
}

describe('i18n JSX fragment spacing guard', () => {
  for (const testCase of CASES) {
    it(`keeps an explicit space after "${testCase.label}" in ${testCase.file}`, () => {
      const source = readFileSync(path.join(ROOT, testCase.file), 'utf8')
      expect(
        hasExplicitSpaceAfterFallback(source, testCase.afterFallback),
        `Expected {' '} immediately after translate fallback "${testCase.afterFallback}" in ${testCase.file}`
      ).toBe(true)
    })
  }
})
