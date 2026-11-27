import { useState } from 'react'
import { Paperclip, Send } from 'lucide-react'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { Button } from '@/components/ui/button'
import type { AgentJournalWorkTarget } from '../../../../../../shared/agent-session/work-target/agent-session-work-target'
import type { BotWorkTargetTreeRow } from './bot-work-target-tree'
import {
  NativeChatComposerWorkTargetChip,
  NativeChatWorkTargetTag
} from './NativeChatWorkTargetBadge'
import { NativeChatWorkTargetPicker } from './NativeChatWorkTargetPicker'

const SYNTHETIC_LOCAL_PROJECT: AgentJournalWorkTarget = {
  kind: 'project',
  hostId: 'local',
  repoId: 'repo-acme-local',
  repoKind: 'git',
  displayName: 'acme-api',
  hostLabel: 'Local'
}

const SYNTHETIC_AUTH_WORKSPACE: AgentJournalWorkTarget = {
  kind: 'workspace',
  hostId: 'local',
  repoId: 'repo-acme-local',
  repoKind: 'git',
  workspaceId: 'wt-auth-fix',
  workspaceKind: 'git-worktree',
  displayName: 'feat/auth-fix',
  projectName: 'acme-api',
  hostLabel: 'Local'
}

const SYNTHETIC_REMOTE_PROJECT: AgentJournalWorkTarget = {
  kind: 'project',
  hostId: 'runtime:env-build',
  repoId: 'repo-acme-remote',
  repoKind: 'git',
  displayName: 'acme-api',
  hostLabel: 'Build Server'
}

const SYNTHETIC_FOLDER_PROJECT: AgentJournalWorkTarget = {
  kind: 'project',
  hostId: 'local',
  repoId: 'repo-design-notes',
  repoKind: 'folder',
  workspaceId: 'repo-design-notes::/workspace/design-notes',
  workspaceKind: 'folder',
  displayName: 'design-notes',
  hostLabel: 'Local'
}

const SYNTHETIC_FOLDER_WORKSPACE: AgentJournalWorkTarget = {
  kind: 'workspace',
  hostId: 'local',
  workspaceId: 'folder:fw-runbooks',
  workspaceKind: 'folder',
  displayName: 'runbooks',
  projectName: 'Operations',
  hostLabel: 'Local'
}

const SYNTHETIC_ROWS: readonly BotWorkTargetTreeRow[] = [
  {
    id: 'project:local:repo-acme-local',
    parentRowId: null,
    depth: 0,
    kind: 'project',
    repoKind: 'git',
    displayName: 'acme-api',
    detail: '…/local/acme-api',
    hostId: 'local',
    hostLabel: 'Local',
    ambiguousName: true,
    searchText: 'acme-api local /workspace/local/acme-api git',
    target: SYNTHETIC_LOCAL_PROJECT
  },
  {
    id: 'workspace:local:wt-main',
    parentRowId: 'project:local:repo-acme-local',
    depth: 1,
    kind: 'workspace',
    repoKind: 'git',
    workspaceKind: 'git-worktree',
    isMainWorktree: true,
    displayName: 'main',
    detail: 'Main',
    hostId: 'local',
    hostLabel: 'Local',
    ambiguousName: false,
    searchText: 'main acme-api local',
    target: {
      kind: 'workspace',
      hostId: 'local',
      repoId: 'repo-acme-local',
      repoKind: 'git',
      workspaceId: 'wt-main',
      workspaceKind: 'git-worktree',
      displayName: 'main',
      projectName: 'acme-api',
      hostLabel: 'Local'
    }
  },
  {
    id: 'workspace:local:wt-auth-fix',
    parentRowId: 'project:local:repo-acme-local',
    depth: 2,
    kind: 'workspace',
    repoKind: 'git',
    workspaceKind: 'git-worktree',
    displayName: 'feat/auth-fix',
    detail: 'fix/token-refresh',
    hostId: 'local',
    hostLabel: 'Local',
    ambiguousName: false,
    searchText: 'feat/auth-fix fix/token-refresh acme-api local',
    target: SYNTHETIC_AUTH_WORKSPACE
  },
  {
    id: 'project:runtime:env-build:repo-acme-remote',
    parentRowId: null,
    depth: 0,
    kind: 'project',
    repoKind: 'git',
    displayName: 'acme-api',
    detail: '…/srv/acme-api',
    hostId: 'runtime:env-build',
    hostLabel: 'Build Server',
    ambiguousName: true,
    searchText: 'acme-api build server /srv/acme-api git',
    target: SYNTHETIC_REMOTE_PROJECT
  },
  {
    id: 'project:local:repo-design-notes',
    parentRowId: null,
    depth: 0,
    kind: 'project',
    repoKind: 'folder',
    workspaceKind: 'folder',
    displayName: 'design-notes',
    detail: 'Folder project',
    hostId: 'local',
    hostLabel: 'Local',
    ambiguousName: false,
    searchText: 'design-notes local folder',
    target: SYNTHETIC_FOLDER_PROJECT
  },
  {
    id: 'workspace:local:folder:fw-runbooks',
    parentRowId: null,
    depth: 0,
    kind: 'workspace',
    workspaceKind: 'folder',
    displayName: 'runbooks',
    detail: 'Operations · Folder',
    hostId: 'local',
    hostLabel: 'Local',
    ambiguousName: false,
    searchText: 'runbooks operations local folder',
    target: SYNTHETIC_FOLDER_WORKSPACE
  },
  {
    id: 'project:ssh:build-box:repo-ssh-service',
    parentRowId: null,
    depth: 0,
    kind: 'project',
    repoKind: 'git',
    displayName: 'edge-gateway',
    hostId: 'ssh:build-box',
    hostLabel: 'Build SSH',
    ambiguousName: false,
    unavailableReason: 'ssh-project-unsupported',
    searchText: 'edge-gateway build ssh git',
    target: {
      kind: 'project',
      hostId: 'ssh:build-box',
      repoId: 'repo-ssh-service',
      repoKind: 'git',
      displayName: 'edge-gateway',
      hostLabel: 'Build SSH'
    }
  },
  {
    id: 'workspace:ssh:build-box:wt-ssh-main',
    parentRowId: 'project:ssh:build-box:repo-ssh-service',
    depth: 1,
    kind: 'workspace',
    repoKind: 'git',
    workspaceKind: 'git-worktree',
    isMainWorktree: true,
    displayName: 'main',
    detail: 'Main',
    hostId: 'ssh:build-box',
    hostLabel: 'Build SSH',
    ambiguousName: false,
    searchText: 'main edge-gateway build ssh',
    target: {
      kind: 'workspace',
      hostId: 'ssh:build-box',
      repoId: 'repo-ssh-service',
      repoKind: 'git',
      workspaceId: 'wt-ssh-main',
      workspaceInstanceId: 'inst-ssh-main',
      workspaceKind: 'git-worktree',
      displayName: 'main',
      projectName: 'edge-gateway',
      hostLabel: 'Build SSH'
    }
  },
  {
    id: 'project:ssh:staging-box:repo-staging-api',
    parentRowId: null,
    depth: 0,
    kind: 'project',
    repoKind: 'git',
    displayName: 'staging-api',
    hostId: 'ssh:staging-box',
    hostLabel: 'Staging SSH',
    ambiguousName: false,
    unavailableReason: 'offline',
    searchText: 'staging-api staging ssh git',
    target: {
      kind: 'project',
      hostId: 'ssh:staging-box',
      repoId: 'repo-staging-api',
      repoKind: 'git',
      displayName: 'staging-api',
      hostLabel: 'Staging SSH'
    }
  }
]

function ComposerShell({
  initialOpen = false,
  initialSelected = null,
  draftText = '',
  showMessages = false
}: {
  initialOpen?: boolean
  initialSelected?: AgentJournalWorkTarget | null
  draftText?: string
  showMessages?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(initialOpen)
  const [selected, setSelected] = useState<AgentJournalWorkTarget | null>(initialSelected)
  return (
    <div className="native-chat-appearance flex flex-col gap-3 bg-background p-4 text-foreground">
      {showMessages ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-col items-end gap-1">
            <NativeChatWorkTargetTag target={SYNTHETIC_REMOTE_PROJECT} />
            <div className="max-w-[85%] rounded-2xl bg-secondary px-3 py-2 text-xs text-foreground">
              Run the integration suite on the build server checkout.
            </div>
          </div>
          <div className="rounded-lg border border-border bg-card/80 px-3 py-2">
            <div className="mb-1 flex items-center justify-between text-2xs text-muted-foreground">
              <span>Queued</span>
              <NativeChatWorkTargetTag target={SYNTHETIC_FOLDER_WORKSPACE} />
            </div>
            <p className="text-xs text-foreground">Update the on-call escalation checklist.</p>
          </div>
        </div>
      ) : null}
      <div className="rounded-xl border border-border bg-card p-2.5 shadow-sm">
        {selected ? (
          <div className="mb-2 flex items-center gap-1.5">
            <NativeChatComposerWorkTargetChip
              target={selected}
              onOpenPicker={() => setOpen(true)}
              onClear={() => setSelected(null)}
            />
          </div>
        ) : null}
        <div className="min-h-10 px-1 py-1 text-xs text-foreground">
          {draftText || (
            <span className="text-muted-foreground">
              Ask HelperBot anything… (Press Ctrl+Shift+P to target a project or workspace)
            </span>
          )}
        </div>
        <div className="mt-2 flex items-center justify-between border-t border-border/60 pt-2">
          <div className="flex items-center gap-1">
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Attach files">
              <Paperclip className="size-4" />
            </Button>
            <NativeChatWorkTargetPicker
              open={open}
              onOpenChange={setOpen}
              botHostId="local"
              supported
              selectedTarget={selected}
              onSelectTarget={setSelected}
              rowsOverride={SYNTHETIC_ROWS}
            />
          </div>
          <Button type="button" size="icon-sm" aria-label="Send message">
            <Send className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )
}

export const beforeIdle = defineFixture({
  width: 520,
  render: () => <ComposerShell />
})

export const openTree = defineFixture({
  width: 520,
  render: () => (
    <div className="pt-80">
      <ComposerShell initialOpen initialSelected={SYNTHETIC_AUTH_WORKSPACE} />
    </div>
  )
})

export const selectedDraftAndMessages = defineFixture({
  width: 520,
  render: () => (
    <ComposerShell
      initialSelected={SYNTHETIC_AUTH_WORKSPACE}
      draftText="Check why token refresh fails on concurrent 401 responses."
      showMessages
    />
  )
})
