import { defineFixture } from '../../component-fixtures/component-fixture'
import { SetupScriptPromptCardShell } from './SetupScriptPromptCardShell'

const noop = (): void => {}

const longSetup = [
  'corepack enable',
  'pnpm install --frozen-lockfile --prefer-offline --reporter=append-only --filter "./packages/**" --filter "./apps/web"',
  'cp "$CONDUCTOR_ROOT_PATH/.env.local" .env.local',
  'pnpm --filter @acme/db run migrate:dev -- --skip-seed',
  'pnpm --filter @acme/web run build:icons',
  'docker compose -f infra/docker-compose.dev.yml up -d postgres redis minio',
  'until pg_isready -h localhost -p 5432; do sleep 1; done',
  'pnpm --filter @acme/db run seed -- --profile=small',
  'pnpm --filter @acme/web exec playwright install chromium',
  'echo "Workspace ready on port $CONDUCTOR_PORT"'
].join('\n')

const base = {
  repoBadgeColor: '#7c3aed',
  repoDisplayName: 'acme-web',
  isInspectionError: false,
  sharedSetupIgnored: false,
  isImporting: false,
  renderedStateOk: true,
  onDismiss: noop,
  onRetryInspection: noop,
  onConfigure: noop,
  onImport: noop,
  onSetupDraftChange: noop
}

function Frame({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="relative mt-[360px] bg-worktree-sidebar">{children}</div>
}

export const conductor = defineFixture({
  width: 303,
  render: () => (
    <Frame>
      <SetupScriptPromptCardShell
        {...base}
        isPackageManagerSuggestion={false}
        candidateSource="Conductor (conductor.json)"
        candidateProvenance="conductor.json"
        detectedSetupPreview={{
          setup: longSetup,
          archive: 'docker compose -f infra/docker-compose.dev.yml down --volumes',
          editable: false
        }}
      />
    </Frame>
  )
})

export const conductorReview = defineFixture({
  ...conductor,
  width: 720,
  interact: async (frame) => {
    Array.from(frame.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Review setup script'))
      ?.click()
    // A mouse click never shows the auto-focus ring; drop the one a synthetic click leaves.
    await new Promise((resolve) => requestAnimationFrame(resolve))
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
  }
})

export const packageManager = defineFixture({
  width: 303,
  render: () => (
    <Frame>
      <SetupScriptPromptCardShell
        {...base}
        isPackageManagerSuggestion
        candidateSource="package manager (pnpm-lock.yaml)"
        candidateProvenance="pnpm-lock.yaml"
        detectedSetupPreview={{ setup: 'pnpm install', archive: null, editable: true }}
      />
    </Frame>
  )
})
