import { defineFixture } from '../../../component-fixtures/component-fixture'
import {
  makeGroup,
  makeRecentTabState,
  makeRepo,
  makeTerminalTab,
  makeUnifiedTab,
  makeWorktree
} from '../../worktree-jump/worktree-jump-palette-test-fixtures'
import TabSearch from './TabSearch'

function focused(tab: ReturnType<typeof makeUnifiedTab>, lastFocusedAt: number) {
  return { ...tab, lastFocusedAt }
}

const store = makeRecentTabState({
  activeModal: 'tab-search',
  activeView: 'terminal',
  activeWorktreeId: 'wt-alpha',
  activeTabType: 'terminal',
  activeTabId: 'term-alpha',
  repos: [makeRepo()],
  worktreesByRepo: {
    'repo-1': [
      makeWorktree('wt-alpha', 'Alpha workspace'),
      makeWorktree('wt-beta', 'Beta workspace')
    ]
  },
  tabsByWorktree: {
    'wt-alpha': [
      makeTerminalTab('term-alpha', 'wt-alpha', 'Alpha chat'),
      makeTerminalTab('term-build', 'wt-alpha', 'pnpm build --watch')
    ],
    'wt-beta': [makeTerminalTab('term-beta', 'wt-beta', 'Beta chat')]
  },
  unifiedTabsByWorktree: {
    'wt-alpha': [
      focused(makeUnifiedTab('tab-alpha', 'wt-alpha', 'term-alpha', 'Alpha chat'), 300),
      focused(makeUnifiedTab('tab-build', 'wt-alpha', 'term-build', 'pnpm build --watch'), 100)
    ],
    'wt-beta': [focused(makeUnifiedTab('tab-beta', 'wt-beta', 'term-beta', 'Beta chat'), 200)]
  },
  groupsByWorktree: {
    'wt-alpha': [makeGroup('wt-alpha', ['tab-alpha', 'tab-build'])],
    'wt-beta': [makeGroup('wt-beta', ['tab-beta'])]
  }
})

export const recentFirst = defineFixture({ width: 760, store, render: () => <TabSearch /> })

export const fuzzyQuery = defineFixture({
  width: 760,
  store,
  render: () => <TabSearch />,
  interact: async () => {
    const input = document.querySelector<HTMLInputElement>('[cmdk-input]')
    if (!input) {
      return
    }
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setValue?.call(input, 'beta wor')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
})
