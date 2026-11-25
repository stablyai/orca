const TRANSCRIPTION_PATH = '/audio/transcriptions'

/** Accepts a base like `https://api.groq.com/openai/v1` or the full transcriptions URL. */
export function openAiCompatibleTranscriptionUrl(baseUrl: string): string {
  let url: URL
  try {
    url = new URL(baseUrl.trim())
  } catch {
    throw new Error('Enter a full base URL, such as https://api.groq.com/openai/v1')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('The base URL must start with https:// or http://')
  }
  // fetch refuses these, and its error would echo the password.
  if (url.username || url.password) {
    throw new Error('Put the key in the API Key field, not in the base URL')
  }
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path.endsWith(TRANSCRIPTION_PATH) ? path : `${path}${TRANSCRIPTION_PATH}`
  return url.toString()
}
