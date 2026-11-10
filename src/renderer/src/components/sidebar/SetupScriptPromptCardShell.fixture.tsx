import { defineFixture } from '../../component-fixtures/component-fixture'
import { SetupScriptPromptCardShell } from './SetupScriptPromptCardShell'

const noop = (): void => {}

const shortSetup = ['pnpm install', 'cp "$CONDUCTOR_ROOT_PATH/.env.local" .env.local'].join('\n')

const longSetup = Array.from({ length: 40 }, (_, index) => {
  const step = index + 1
  return step % 7 === 0
    ? `docker compose -f infra/docker-compose.dev.yml run --rm --service-ports --name step-${step} toolbox ./scripts/bootstrap.sh --profile=full --skip-seed`
    : `pnpm --filter @acme/pkg-${step} run setup`
}).join('\n')

const hugeSetup = Array.from(
  { length: 2000 },
  (_, index) =>
    `echo "step ${index + 1}" && ./scripts/run-step.sh --index=${index + 1} ${'--flag=value '.repeat(20)}`
).join('\n')

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

function clickButton(frame: HTMLElement | Document, label: string): void {
  Array.from(frame.querySelectorAll('button'))
    .find((button) => button.textContent?.includes(label))
    ?.click()
}

async function openReview(frame: HTMLElement): Promise<void> {
  clickButton(frame, 'Review setup script')
  // A mouse click never shows the auto-focus ring; drop the one a synthetic click leaves.
  await new Promise((resolve) => requestAnimationFrame(resolve))
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur()
  }
}

export const conductor = defineFixture({
  width: 303,
  render: () => (
    <Frame>
      <SetupScriptPromptCardShell
        {...base}
        isPackageManagerSuggestion={false}
        candidateSource="Conductor (.conductor/settings.toml)"
        candidateProvenance=".conductor/settings.toml"
        detectedSetupPreview={{
          setup: shortSetup,
          archive: null,
          editable: false,
          skippedFields: ['scripts.run']
        }}
      />
    </Frame>
  )
})

export const conductorReview = defineFixture({
  ...conductor,
  width: 720,
  interact: openReview
})

export const devcontainer = defineFixture({
  width: 303,
  render: () => (
    <Frame>
      <SetupScriptPromptCardShell
        {...base}
        isPackageManagerSuggestion={false}
        candidateSource="Dev container (.devcontainer/devcontainer.json)"
        candidateProvenance=".devcontainer/devcontainer.json"
        detectedSetupPreview={{
          setup: longSetup,
          archive: 'docker compose -f infra/docker-compose.dev.yml down --volumes',
          editable: false,
          skippedFields: ['postStartCommand', 'postAttachCommand', 'features', 'forwardPorts']
        }}
      />
    </Frame>
  )
})

export const devcontainerReview = defineFixture({
  ...devcontainer,
  width: 720,
  interact: openReview
})

async function openReviewExpanded(frame: HTMLElement): Promise<void> {
  await openReview(frame)
  for (const toggle of document.querySelectorAll<HTMLButtonElement>(
    'button[aria-expanded="false"][aria-controls]'
  )) {
    toggle.click()
  }
  await new Promise((resolve) => setTimeout(resolve, 400))
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur()
  }
}

export const devcontainerReviewExpanded = defineFixture({
  ...devcontainer,
  width: 720,
  interact: openReviewExpanded
})

// 2,000 long lines in setup and archive: the dialog must stay within the viewport with Save visible.
export const hugeReviewExpanded = defineFixture({
  width: 720,
  render: () => (
    <Frame>
      <SetupScriptPromptCardShell
        {...base}
        isPackageManagerSuggestion={false}
        candidateSource="GitHub Copilot setup steps"
        candidateProvenance=".github/workflows/copilot-setup-steps.yml"
        detectedSetupPreview={{
          setup: hugeSetup,
          archive: hugeSetup,
          editable: false,
          skippedFields: Array.from({ length: 30 }, (_, index) => `steps.${index}.uses`)
        }}
      />
    </Frame>
  ),
  interact: openReviewExpanded
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
        detectedSetupPreview={{
          setup: 'pnpm install',
          archive: null,
          editable: true,
          skippedFields: []
        }}
      />
    </Frame>
  )
})
