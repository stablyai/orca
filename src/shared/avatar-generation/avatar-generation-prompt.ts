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
    'Do not run shell commands or edit files.'
  ].join(' ')
}
