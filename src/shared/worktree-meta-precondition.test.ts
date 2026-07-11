import { describe, expect, it } from 'vitest'
import {
  worktreeMetaPreconditionHolds,
  type WorktreeMetaPrecondition,
  type WorktreeMetaPreconditionState
} from './worktree-meta-precondition'

const CURRENT: WorktreeMetaPreconditionState = {
  linkedPR: 42,
  branch: 'feature/x',
  head: 'aaaa'
}

type PreconditionCase = {
  name: string
  precondition: WorktreeMetaPrecondition
  current: WorktreeMetaPreconditionState
  expected: boolean
}

describe('worktreeMetaPreconditionHolds', () => {
  const cases: PreconditionCase[] = [
    // Empty precondition → always holds (LWW callers never opt in).
    { name: 'empty precondition holds', precondition: {}, current: CURRENT, expected: true },

    // Each field present and matching.
    {
      name: 'linkedPR present + matches',
      precondition: { expectedLinkedPR: 42 },
      current: CURRENT,
      expected: true
    },
    {
      name: 'branch present + matches',
      precondition: { expectedBranch: 'feature/x' },
      current: CURRENT,
      expected: true
    },
    {
      name: 'head present + matches',
      precondition: { expectedHead: 'aaaa' },
      current: CURRENT,
      expected: true
    },
    {
      name: 'full triple matches',
      precondition: { expectedLinkedPR: 42, expectedBranch: 'feature/x', expectedHead: 'aaaa' },
      current: CURRENT,
      expected: true
    },

    // Each field present and mismatching.
    {
      name: 'linkedPR mismatch',
      precondition: { expectedLinkedPR: 7 },
      current: CURRENT,
      expected: false
    },
    {
      name: 'branch mismatch',
      precondition: { expectedBranch: 'feature/other' },
      current: CURRENT,
      expected: false
    },
    {
      name: 'head mismatch (the diverged-clear discriminator)',
      precondition: { expectedHead: 'bbbb' },
      current: CURRENT,
      expected: false
    },
    {
      name: 'full triple with only head moved → rejected',
      precondition: { expectedLinkedPR: 42, expectedBranch: 'feature/x', expectedHead: 'bbbb' },
      current: CURRENT,
      expected: false
    },

    // Absent fields are skipped even when current differs.
    {
      name: 'absent branch/head skipped, linkedPR-only matches',
      precondition: { expectedLinkedPR: 42 },
      current: { linkedPR: 42, branch: 'totally-different', head: 'zzzz' },
      expected: true
    },

    // Branch normalization: refs/heads/ prefix stripped on both sides.
    {
      name: 'branch precondition with refs/heads/ prefix matches bare current',
      precondition: { expectedBranch: 'refs/heads/feature/x' },
      current: CURRENT,
      expected: true
    },
    {
      name: 'bare branch precondition matches refs/heads/ current',
      precondition: { expectedBranch: 'feature/x' },
      current: { ...CURRENT, branch: 'refs/heads/feature/x' },
      expected: true
    },

    // null-normalization: expected null vs undefined/null current.
    {
      name: 'expectedLinkedPR null matches current null',
      precondition: { expectedLinkedPR: null },
      current: { ...CURRENT, linkedPR: null },
      expected: true
    },
    {
      name: 'expectedLinkedPR null mismatches a real PR',
      precondition: { expectedLinkedPR: null },
      current: CURRENT,
      expected: false
    },
    {
      name: 'expectedHead null matches current undefined head',
      precondition: { expectedHead: null },
      current: { ...CURRENT, head: undefined },
      expected: true
    },
    {
      name: 'expectedHead null matches current null head',
      precondition: { expectedHead: null },
      current: { ...CURRENT, head: null },
      expected: true
    },
    {
      name: 'expectedHead null mismatches a real head',
      precondition: { expectedHead: null },
      current: CURRENT,
      expected: false
    },

    // Branch precondition present but current branch undefined → mismatch.
    {
      name: 'branch precondition against undefined current branch mismatches',
      precondition: { expectedBranch: 'feature/x' },
      current: { ...CURRENT, branch: undefined },
      expected: false
    }
  ]

  for (const { name, precondition, current, expected } of cases) {
    it(name, () => {
      expect(worktreeMetaPreconditionHolds(precondition, current)).toBe(expected)
    })
  }
})
