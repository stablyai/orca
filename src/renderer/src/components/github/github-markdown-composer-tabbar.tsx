import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { ReactNode } from 'react'

export type ComposerTab = 'write' | 'preview'

export function GitHubMarkdownComposerTabbar({
  activeTab,
  onTabChange,
  children
}: {
  activeTab: ComposerTab
  onTabChange: (tab: ComposerTab) => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="github-markdown-composer-tabbar">
      <div className="github-markdown-composer-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'write'}
          className={cn('github-markdown-composer-tab', activeTab === 'write' && 'is-active')}
          onClick={() => onTabChange('write')}
        >
          {translate('auto.components.github.GitHubMarkdownComposer.c91f0a2b14', 'Write')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'preview'}
          className={cn('github-markdown-composer-tab', activeTab === 'preview' && 'is-active')}
          onClick={() => onTabChange('preview')}
        >
          {translate('auto.components.github.GitHubMarkdownComposer.d82b1e3f05', 'Preview')}
        </button>
      </div>
      {activeTab === 'write' ? (
        <div className="github-markdown-composer-tabbar-toolbar">{children}</div>
      ) : null}
    </div>
  )
}
