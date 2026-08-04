// THE SINGLE-VOCABULARY CONTRACT.
//
// Codex plan verdicts use the EXISTING ReviewVerdict ('approved' |
// 'fixes_requested' | 'blocked'). A second, semantically identical union
// ('accepted' | 'changes_requested' | ...) would have to be bridged at the
// last_verdict write site by a cast or a lossy mapping table kept in sync
// forever. These tests fail if that vocabulary ever creeps back in.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REVIEW_VERDICTS } from './audited-workflow-types'
import * as planArtifactTypes from './audited-plan-artifact-types'

const ROOT = join(__dirname, '..')

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8')
}

/**
 * Strips comments so the assertions test CODE, not prose. These modules
 * deliberately explain in comments which vocabulary they reject, and naming it
 * there is the documentation working — not a violation.
 */
function readCode(relativePath: string): string {
  return read(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('one verdict vocabulary', () => {
  it('ReviewVerdict is exactly the three durable values', () => {
    expect([...REVIEW_VERDICTS]).toEqual(['approved', 'fixes_requested', 'blocked'])
  })

  it('the plan-artifact types module exports NO parallel verdict const', () => {
    const exported = Object.keys(planArtifactTypes)
    expect(exported).not.toContain('PLAN_REVIEW_VERDICTS')
    // PlanReviewVerdict exists only as a type alias of ReviewVerdict, so it
    // cannot appear as a runtime value.
    expect(exported.filter((name) => /VERDICT/i.test(name))).toEqual([])
  })

  it.each([
    'shared/audited-plan-artifact-types.ts',
    'main/audited-workflow/audited-plan-review-run-repository.ts',
    'main/audited-workflow/audited-plan-review-run-finalize.ts',
    'main/audited-workflow/audited-plan-review-outcome.ts',
    'main/audited-workflow/audited-plan-review-approval.ts',
    'renderer/src/components/audited-workflow/audited-plan-review-labels.ts'
  ])('%s never uses the rejected vocabulary as a value', (relativePath) => {
    const source = readCode(relativePath)
    // Quoted string literals in CODE only — a comment naming the rejected
    // vocabulary is the documentation doing its job.
    expect(source).not.toMatch(/['"]accepted['"]/)
    expect(source).not.toMatch(/['"]changes_requested['"]/)
  })

  it('the approval query checks for the durable value, not a UI label', () => {
    const source = read('main/audited-workflow/audited-plan-review-run-repository.ts')
    expect(source).toContain("r.verdict = 'approved'")
  })

  it('the schema CHECK is generated from REVIEW_VERDICTS', () => {
    const source = read('main/audited-workflow/audited-task-schema.ts')
    expect(source).toContain('REVIEW_VERDICTS.map')
  })

  it('the parser validates against REVIEW_VERDICTS', () => {
    const source = read('main/audited-workflow/audited-plan-audit-verdict.ts')
    expect(source).toContain('z.enum(REVIEW_VERDICTS)')
  })

  it('the prompt asks for the durable tokens', () => {
    const source = read('main/audited-workflow/audited-plan-audit-prompt.ts')
    expect(source).toContain('approved|fixes_requested|blocked')
  })

  it('the UI rename lives ONLY in the label module', () => {
    const labels = read('renderer/src/components/audited-workflow/audited-plan-review-labels.ts')
    expect(labels).toContain("'Accepted'")
    expect(labels).toContain("'Changes requested'")

    // The panel must render through the label helper, never hardcode the words.
    const panel = readCode('renderer/src/components/audited-workflow/AuditedPlanReviewPanel.tsx')
    expect(panel).toContain('getPlanReviewVerdictLabel')
    expect(panel).not.toContain("'Accepted'")
  })
})
