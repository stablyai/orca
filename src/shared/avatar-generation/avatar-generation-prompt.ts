// The words around a user's avatar description, and the check that turns away real people first.

// Only clear asks for a real person; named public figures are left to the agent's own refusal.
const REAL_PERSON_PATTERNS: readonly RegExp[] = [
  /(^|\b(of|like|as|depicting) )(me|myself|us)\b/i,
  /\b(me|myself|us) as\b/i,
  /\b(draw|make|paint|show|create) (me|myself|us)\s*[.!]?\s*$/i,
  /\b(my|our) (face|photo|picture|selfie|likeness)\b/i,
  /\b(my|our) (wife|husband|partner|boyfriend|girlfriend|son|daughter|kids?|child|children|mom|mother|dad|father|brother|sister|friend|boss|coworker|colleague)\b/i,
  /\b(real|actual) (person|people|human)\b/i,
  /\b(celebrity|celebrities|politician)\b/i
]

/** Whether a description asks for a real, identifiable person; checked before any agent runs. */
export function describesRealPerson(description: string): boolean {
  const text = description.replace(/\s+/g, ' ').trim()
  return REAL_PERSON_PATTERNS.some((pattern) => pattern.test(text))
}

/** One line, with the user's text as the subject inside fixed instructions. */
export function avatarGenerationPrompt(description: string): string {
  const subject = description.replace(/\s+/g, ' ').trim()
  return [
    'Use your image generation tool to create exactly one image, then stop.',
    'It is a profile avatar for an AI assistant in a chat app, shown small and cropped to a circle, so it must read instantly at thumbnail size.',
    `Subject: ${subject}`,
    'Make it a square 1:1 image with the subject centered and filling most of the frame, on a simple uncluttered background that runs to the edges.',
    'Use a stylized character illustration with bold readable shapes and a limited palette, unless the subject names another art style.',
    'Do not draw a circle, badge, border or frame. No text, letters, logos, watermarks or interface elements.',
    'Never depict a real, identifiable person, including public figures; if the subject asks for one, make no image and reply REFUSED.',
    'Do not run shell commands or edit files.'
  ].join(' ')
}
