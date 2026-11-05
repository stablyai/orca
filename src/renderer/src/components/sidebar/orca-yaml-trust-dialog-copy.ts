import { translate } from '@/i18n/i18n'
import type { OrcaHookScriptKind, OrcaHookTrustUsage } from '@/lib/orca-hook-trust'

type ScriptKind = OrcaHookScriptKind
// Repo text that becomes the agent's prompt rather than a command Orca runs.
type PromptKind = Extract<ScriptKind, 'issueCommand' | 'reviewCommand'>
type ShellKind = Exclude<ScriptKind, 'reviewCommand'>

export type OrcaYamlTrustDialogCopy = {
  title: string
  description: string
  heading: string
  approve: string
  decline: string
}

function getPromptCopy(
  kind: PromptKind,
  repoName: string,
  previouslyApproved: boolean
): OrcaYamlTrustDialogCopy {
  const repo = { repo: repoName }
  const isReview = kind === 'reviewCommand'
  const approve = translate('auto.components.sidebar.OrcaYamlTrustDialog.usePrompt', 'Use prompt')
  const decline = translate(
    'auto.components.sidebar.OrcaYamlTrustDialog.dontUsePrompt',
    "Don't use"
  )
  if (previouslyApproved) {
    return {
      title: isReview
        ? translate(
            'auto.components.sidebar.OrcaYamlTrustDialog.reviewPromptChangedTitle',
            "{{repo}}'s review prompt changed — use the new version?",
            repo
          )
        : translate(
            'auto.components.sidebar.OrcaYamlTrustDialog.issuePromptChangedTitle',
            "{{repo}}'s issue prompt changed — use the new version?",
            repo
          ),
      description: isReview
        ? translate(
            'auto.components.sidebar.OrcaYamlTrustDialog.reviewPromptChangedBody',
            '<code>orca.yaml</code> changed since you last approved. Re-review before Orca sends it to the agent when this workspace launches with a linked pull or merge request.'
          )
        : translate(
            'auto.components.sidebar.OrcaYamlTrustDialog.issuePromptChangedBody',
            '<code>orca.yaml</code> changed since you last approved. Re-review before Orca sends it to the agent when this workspace launches with a linked issue.'
          ),
      heading: isReview
        ? translate(
            'auto.components.sidebar.OrcaYamlTrustDialog.newReviewPrompt',
            'New review prompt'
          )
        : translate(
            'auto.components.sidebar.OrcaYamlTrustDialog.newIssuePrompt',
            'New issue prompt'
          ),
      approve,
      decline
    }
  }
  return {
    title: isReview
      ? translate(
          'auto.components.sidebar.OrcaYamlTrustDialog.reviewPromptUseTitle',
          'Use review prompt from {{repo}}?',
          repo
        )
      : translate(
          'auto.components.sidebar.OrcaYamlTrustDialog.issuePromptUseTitle',
          'Use issue prompt from {{repo}}?',
          repo
        ),
    description: isReview
      ? translate(
          'auto.components.sidebar.OrcaYamlTrustDialog.reviewPromptUseBody',
          "This repository's <code>orca.yaml</code> becomes the prompt Orca sends the agent when this workspace launches with a linked pull or merge request. Only use it if you trust <repo/>."
        )
      : translate(
          'auto.components.sidebar.OrcaYamlTrustDialog.issuePromptUseBody',
          "This repository's <code>orca.yaml</code> becomes the prompt Orca sends the agent when this workspace launches with a linked issue. Only use it if you trust <repo/>."
        ),
    heading: isReview
      ? translate('auto.components.sidebar.OrcaYamlTrustDialog.reviewPrompt', 'Review prompt')
      : translate('auto.components.sidebar.OrcaYamlTrustDialog.issuePrompt', 'Issue prompt'),
    approve,
    decline
  }
}

function getShellCopy(
  kind: ShellKind,
  repoName: string,
  previouslyApproved: boolean
): OrcaYamlTrustDialogCopy {
  return {
    title: getTitle(kind, repoName, previouslyApproved),
    description: getDescription(kind, previouslyApproved),
    heading: getScriptHeading(kind, previouslyApproved),
    approve: translate('auto.components.sidebar.OrcaYamlTrustDialog.f3e2b868fb', 'Run hooks'),
    decline: translate('auto.components.sidebar.OrcaYamlTrustDialog.43b7bec4cd', "Don't run")
  }
}

export function getOrcaYamlTrustDialogCopy(
  kind: ScriptKind,
  usage: OrcaHookTrustUsage,
  repoName: string,
  previouslyApproved: boolean
): OrcaYamlTrustDialogCopy {
  if (kind === 'reviewCommand' || (kind === 'issueCommand' && usage === 'prompt')) {
    return getPromptCopy(kind, repoName, previouslyApproved)
  }
  return getShellCopy(kind, repoName, previouslyApproved)
}

function getTitle(kind: ShellKind, repoName: string, previouslyApproved: boolean): string {
  const repo = { repo: repoName }
  if (previouslyApproved) {
    switch (kind) {
      case 'setup':
        return translate(
          'auto.components.sidebar.OrcaYamlTrustDialog.setupChangedTitle',
          "{{repo}}'s setup script changed — run the new version?",
          repo
        )
      case 'archive':
        return translate(
          'auto.components.sidebar.OrcaYamlTrustDialog.archiveChangedTitle',
          "{{repo}}'s archive script changed — run the new version?",
          repo
        )
      case 'issueCommand':
        return translate(
          'auto.components.sidebar.OrcaYamlTrustDialog.issueCommandChangedTitle',
          "{{repo}}'s issue command changed — run the new version?",
          repo
        )
      case 'vmRecipe':
        return translate(
          'auto.components.sidebar.OrcaYamlTrustDialog.vmRecipeChangedTitle',
          "{{repo}}'s VM recipe changed — run the new version?",
          repo
        )
    }
  }
  switch (kind) {
    case 'setup':
      return translate(
        'auto.components.sidebar.OrcaYamlTrustDialog.setupRunTitle',
        'Run setup script from {{repo}}?',
        repo
      )
    case 'archive':
      return translate(
        'auto.components.sidebar.OrcaYamlTrustDialog.archiveRunTitle',
        'Run archive script from {{repo}}?',
        repo
      )
    case 'issueCommand':
      return translate(
        'auto.components.sidebar.OrcaYamlTrustDialog.issueCommandRunTitle',
        'Run issue command from {{repo}}?',
        repo
      )
    case 'vmRecipe':
      return translate(
        'auto.components.sidebar.OrcaYamlTrustDialog.vmRecipeRunTitle',
        'Run VM recipe from {{repo}}?',
        repo
      )
  }
}

// Templates embed <code>orca.yaml</code> and a <repo/> slot filled by the component.
function getDescription(kind: ShellKind, previouslyApproved: boolean): string {
  if (previouslyApproved) {
    switch (kind) {
      case 'setup':
        return translate(
          'auto.components.sidebar.OrcaYamlTrustDialog.setupChangedBody',
          '<code>orca.yaml</code> changed since you last approved. Re-review before it runs when this workspace is created.'
        )
      case 'archive':
        return translate(
          'auto.components.sidebar.OrcaYamlTrustDialog.archiveChangedBody',
          '<code>orca.yaml</code> changed since you last approved. Re-review before it runs when this workspace is removed.'
        )
      case 'issueCommand':
        return translate(
          'auto.components.sidebar.OrcaYamlTrustDialog.issueCommandChangedBody',
          '<code>orca.yaml</code> changed since you last approved. Re-review before it runs when this workspace launches with a linked issue.'
        )
      case 'vmRecipe':
        return translate(
          'auto.components.sidebar.OrcaYamlTrustDialog.vmRecipeChangedBody',
          '<code>orca.yaml</code> changed since you last approved. Re-review before it runs before provisioning a VM.'
        )
    }
  }
  switch (kind) {
    case 'setup':
      return translate(
        'auto.components.sidebar.OrcaYamlTrustDialog.setupRunBody',
        "This repository's <code>orca.yaml</code> runs on your machine when this workspace is created. Only run if you trust <repo/>."
      )
    case 'archive':
      return translate(
        'auto.components.sidebar.OrcaYamlTrustDialog.archiveRunBody',
        "This repository's <code>orca.yaml</code> runs on your machine when this workspace is removed. Only run if you trust <repo/>."
      )
    case 'issueCommand':
      return translate(
        'auto.components.sidebar.OrcaYamlTrustDialog.issueCommandRunBody',
        "This repository's <code>orca.yaml</code> runs on your machine when this workspace launches with a linked issue. Only run if you trust <repo/>."
      )
    case 'vmRecipe':
      return translate(
        'auto.components.sidebar.OrcaYamlTrustDialog.vmRecipeRunBody',
        "This repository's <code>orca.yaml</code> runs on your machine before provisioning a VM. Only run if you trust <repo/>."
      )
  }
}

function getScriptHeading(kind: ShellKind, previouslyApproved: boolean): string {
  switch (kind) {
    case 'setup':
      return previouslyApproved
        ? translate(
            'auto.components.sidebar.OrcaYamlTrustDialog.newSetupScript',
            'New setup script'
          )
        : translate('auto.components.sidebar.OrcaYamlTrustDialog.setupScript', 'Setup script')
    case 'archive':
      return previouslyApproved
        ? translate(
            'auto.components.sidebar.OrcaYamlTrustDialog.newArchiveScript',
            'New archive script'
          )
        : translate('auto.components.sidebar.OrcaYamlTrustDialog.archiveScript', 'Archive script')
    case 'issueCommand':
      return previouslyApproved
        ? translate(
            'auto.components.sidebar.OrcaYamlTrustDialog.newIssueCommand',
            'New issue command'
          )
        : translate('auto.components.sidebar.OrcaYamlTrustDialog.issueCommand', 'Issue command')
    case 'vmRecipe':
      return previouslyApproved
        ? translate('auto.components.sidebar.OrcaYamlTrustDialog.newVmRecipe', 'New VM recipe')
        : translate('auto.components.sidebar.OrcaYamlTrustDialog.vmRecipe', 'VM recipe')
  }
}
