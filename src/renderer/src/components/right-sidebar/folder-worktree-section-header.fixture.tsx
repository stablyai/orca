import { defineFixture } from '../../component-fixtures/component-fixture'
import {
  FOLDER_WORKTREE_CARD_CLASS,
  FolderWorktreeSectionHeader
} from './folder-worktree-section-header'

function SectionBody({ files }: { files: string[] }) {
  return (
    <div className="flex flex-col">
      <div className="px-3 pt-2 pb-1 text-2xs font-semibold uppercase text-muted-foreground">
        Changes
      </div>
      {files.map((file) => (
        <div key={file} className="truncate px-5 py-0.5 text-xs">
          {file}
        </div>
      ))}
      <div className="mt-2 border-t border-border bg-card/95 px-3 py-1.5 text-2xs font-semibold uppercase text-muted-foreground">
        Commits
      </div>
    </div>
  )
}

function Cards() {
  return (
    <div className="flex flex-col gap-2.5 bg-sidebar p-2 text-foreground">
      <section className={FOLDER_WORKTREE_CARD_CLASS}>
        <FolderWorktreeSectionHeader
          repoName="api"
          worktreeName="checkout-v2"
          branch="feature/checkout-v2"
          ahead={2}
          behind={1}
          changeCount={3}
          expanded
          onToggle={() => {}}
          onOpen={() => {}}
          actionsSlotRef={() => {}}
        />
        <SectionBody files={['src/main/index.ts', 'src/renderer/App.tsx', 'README.md']} />
      </section>
      <section className={FOLDER_WORKTREE_CARD_CLASS}>
        <FolderWorktreeSectionHeader
          repoName="api"
          worktreeName="checkout-v2-migration"
          branch="feature/checkout-v2-migration"
          changeCount={1}
          expanded
          onToggle={() => {}}
          onOpen={() => {}}
          actionsSlotRef={() => {}}
        />
        <SectionBody files={['package.json']} />
      </section>
      <section className={FOLDER_WORKTREE_CARD_CLASS}>
        <FolderWorktreeSectionHeader
          repoName="docs-site"
          branch="release/2026-11"
          changeCount={0}
          expanded={false}
          onToggle={() => {}}
          onOpen={() => {}}
          actionsSlotRef={() => {}}
        />
      </section>
    </div>
  )
}

export const cards = defineFixture({ width: 305, render: () => <Cards /> })

export const narrow = defineFixture({
  width: 220,
  render: () => (
    <div className="flex flex-col gap-2.5 bg-sidebar p-2 text-foreground">
      <section className={FOLDER_WORKTREE_CARD_CLASS}>
        <FolderWorktreeSectionHeader
          repoName="long-repository-name"
          worktreeName="checkout-v2-migration"
          branch="feature/checkout-v2-migration"
          ahead={12}
          behind={12}
          changeCount={123}
          expanded={false}
          onToggle={() => {}}
          onOpen={() => {}}
          actionsSlotRef={() => {}}
        />
      </section>
    </div>
  )
})
