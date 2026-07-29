import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getAuditedWorkflowSearchEntry = createLocalizedCatalog(
  (): SettingsSearchEntry => ({
    title: translate('auto.components.settings.auditedWorkflow.search.title', 'Audited Workflow'),
    description: translate(
      'auto.components.settings.auditedWorkflow.search.description',
      'A stricter, additive task workflow with human-gated plan review, code audit, approval, commit, and landing.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.0d24759f14',
        'experimental'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.auditedWorkflow.search.keywordAudit',
        'audit'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.auditedWorkflow.search.keywordApproval',
        'approval'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.auditedWorkflow.search.keywordReview',
        'review'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.auditedWorkflow.search.keywordCompliance',
        'compliance'
      )
    ],
    targetSectionId: 'audited-workflow'
  })
)
