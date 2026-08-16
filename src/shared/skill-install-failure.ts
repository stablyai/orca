import { z } from 'zod'

export const SkillInstallFailureCategorySchema = z.enum([
  'admission',
  'transport',
  'archive',
  'filesystem',
  'conflict',
  'recovery',
  'provider-placement',
  'compatibility',
  'cancelled'
])

export type SkillInstallFailureCategory = z.infer<typeof SkillInstallFailureCategorySchema>

export const SkillInstallFailureSchema = z
  .object({
    category: SkillInstallFailureCategorySchema,
    code: z.string().regex(/^skill-[a-z0-9-]+$/),
    retryable: z.boolean()
  })
  .strict()

export type SkillInstallFailure = z.infer<typeof SkillInstallFailureSchema>

export const SKILL_INSTALL_RPC_ERROR_CODE = 'skill_install_failure'

export const SKILL_INSTALL_BUSY_FAILURE: SkillInstallFailure = {
  category: 'filesystem',
  code: 'skill-install-busy',
  retryable: true
}

export const SKILL_INSTALL_CANCELLED_FAILURE: SkillInstallFailure = {
  category: 'cancelled',
  code: 'skill-install-cancelled',
  retryable: true
}

function retryableCode(code: string): boolean {
  return (
    code.includes('busy') ||
    code.includes('timeout') ||
    code.includes('transport') ||
    code.includes('expired') ||
    code.includes('unavailable') ||
    code.includes('failed')
  )
}

export function classifySkillInstallFailureCode(code: string): SkillInstallFailure | null {
  if (!/^skill-[a-z0-9-]+$/.test(code)) {
    return null
  }
  if (code.includes('cancelled')) {
    return { category: 'cancelled', code, retryable: true }
  }
  if (code.includes('recovery') || code.includes('journal') || code.includes('receipt')) {
    return { category: 'recovery', code, retryable: retryableCode(code) }
  }
  if (code.startsWith('skill-placement-') || code.startsWith('skill-discovery-')) {
    return { category: 'provider-placement', code, retryable: retryableCode(code) }
  }
  if (code.includes('conflict') || code.includes('modified') || code.includes('unowned')) {
    return { category: 'conflict', code, retryable: false }
  }
  if (code.startsWith('skill-package-')) {
    return { category: 'archive', code, retryable: false }
  }
  if (
    code.startsWith('skill-download-') ||
    code.startsWith('skill-transfer-') ||
    code.startsWith('skill-cloud-')
  ) {
    return { category: 'transport', code, retryable: retryableCode(code) }
  }
  if (
    code.includes('update-required') ||
    code.includes('unsupported') ||
    code.includes('remote-download-unavailable') ||
    code.includes('ssh-relay-unavailable')
  ) {
    return { category: 'compatibility', code, retryable: false }
  }
  if (
    code.includes('destination') ||
    code.includes('workspace') ||
    code.includes('environment') ||
    code.includes('home-') ||
    code.includes('ingress') ||
    code.includes('name-invalid') ||
    code.includes('wsl-unavailable')
  ) {
    return { category: 'admission', code, retryable: false }
  }
  if (
    code.startsWith('skill-install-') ||
    code.startsWith('skill-remove-') ||
    code.startsWith('skill-removal-')
  ) {
    return { category: 'filesystem', code, retryable: retryableCode(code) }
  }
  return null
}
