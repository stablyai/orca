const MAX_SKILL_BUNDLE_NAME_LENGTH = 64

export function normalizeSkillBundleName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/[-.]{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, MAX_SKILL_BUNDLE_NAME_LENGTH)
    .replace(/[-.]+$/g, '')
}
